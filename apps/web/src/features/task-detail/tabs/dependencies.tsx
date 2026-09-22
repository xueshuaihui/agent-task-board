import { useEffect, useMemo, useState } from 'react';
import { Plus, Trash2, X } from 'lucide-react';
import {
  COPY_DEPENDENCY_HINT,
} from '../labels';
import { errorCodeOf, errorMessage, useTaskList } from '@/api';
import type { DependencyRef, DependencyType, TaskListItem } from '@/api';
import {
  Badge,
  Button,
  Dialog,
  EmptyState,
  Input,
  RadioGroup,
} from '@/components/ui';
import { COPY } from '@/lib/copy';
import { DEPENDENCY_TYPE_LABEL, labelOf, statusLabel } from '@/lib/labels';
import { useShellStore } from '@/app/store/shell';
import { SHOW_DEPENDENCY_GRAPH } from '@/lib/phase';
import { useAddDependency, useRemoveDependency } from '../mutations';
import { useTaskDependencies } from '../queries';
import { InlineError, LoadingBlock, Mono, Section, StatusGlyph } from '../ui-bits';

/**
 * 原型 4.7 + PRD 5.8 依赖标签。
 *
 * 三个分组来自一份 `{depends_on, blocks}`：`type` 是依赖边的类型（`blocks` / `relates`），
 * 不是任务类型，所以「关联」这一组要从两个方向里各挑一次（relates 是对称语义）。
 *
 * `409 DEPENDENCY_CYCLE` 的链路文案内联显示在弹窗里（不弹 Toast）：
 * 用户需要照着链路决定改哪条边，Toast 三秒就消失了。
 */

export function DependenciesTab({ taskId }: { taskId: string }) {
  const deps = useTaskDependencies(taskId);
  const [picker, setPicker] = useState<{ type: DependencyType } | null>(null);

  if (deps.isPending) return <LoadingBlock lines={4} />;
  if (deps.isError) return <InlineError text={deps.error.message} />;

  const dependsOn = deps.data?.depends_on ?? [];
  const blocks = deps.data?.blocks ?? [];
  const upstream = dependsOn.filter((item) => item.type !== 'relates');
  const downstream = blocks.filter((item) => item.type !== 'relates');
  const related = dedupeByDepId([...dependsOn, ...blocks].filter((item) => item.type === 'relates'));
  const done = upstream.filter((item) => item.status === 'DONE').length;

  return (
    <div className="flex flex-col gap-5">
      <Section
        title="前置任务"
        meta={upstream.length > 0 ? `(${done}/${upstream.length} 已完成)` : undefined}
        action={
          <Button size="sm" icon={<Plus className="size-3.5" />} onClick={() => setPicker({ type: 'blocks' })}>
            添加前置
          </Button>
        }
      >
        {upstream.length === 0 ? (
          <p className="text-aux text-text-tertiary">无前置：本任务不被任何任务阻塞（5.4）。</p>
        ) : (
          <DependencyRows refs={upstream} taskId={taskId} removable />
        )}
      </Section>

      <Section title="后续任务" meta={downstream.length > 0 ? `(${downstream.length})` : undefined}>
        {downstream.length === 0 ? (
          <p className="text-aux text-text-tertiary">没有任务把本任务当前置。</p>
        ) : (
          <DependencyRows refs={downstream} taskId={taskId} />
        )}
      </Section>

      <Section
        title="关联任务"
        meta="不影响执行顺序（5.1）"
        action={
          <Button size="sm" variant="ghost" icon={<Plus className="size-3.5" />} onClick={() => setPicker({ type: 'relates' })}>
            添加关联
          </Button>
        }
      >
        {related.length === 0 ? (
          <p className="text-aux text-text-tertiary">无关联任务。</p>
        ) : (
          <DependencyRows refs={related} taskId={taskId} removable />
        )}
      </Section>

      {/* 5.9 依赖图整节属阶段二：阶段一不渲染入口，而不是渲染一个点了报错的按钮。 */}
      {SHOW_DEPENDENCY_GRAPH ? (
        <p className="text-aux text-text-tertiary">依赖图（5.9）在阶段二提供。</p>
      ) : null}

      <DependencyPickerDialog
        taskId={taskId}
        preset={picker}
        existing={[...dependsOn, ...blocks]}
        onClose={() => setPicker(null)}
      />
    </div>
  );
}

function dedupeByDepId(refs: DependencyRef[]): DependencyRef[] {
  const seen = new Set<string>();
  return refs.filter((ref) => (seen.has(ref.dep_id) ? false : (seen.add(ref.dep_id), true)));
}

function DependencyRows({
  refs,
  taskId,
  removable = false,
}: {
  refs: DependencyRef[];
  taskId: string;
  removable?: boolean;
}) {
  return (
    <ul className="divide-y divide-border overflow-hidden rounded-card border border-border bg-bg-surface">
      {refs.map((ref) => (
        <DependencyRow key={ref.dep_id} ref_={ref} taskId={taskId} removable={removable} />
      ))}
    </ul>
  );
}

function DependencyRow({
  ref_: ref,
  taskId,
  removable,
}: {
  ref_: DependencyRef;
  taskId: string;
  removable: boolean;
}) {
  const remove = useRemoveDependency(taskId);
  return (
    <li className="group flex items-center gap-2 px-3 py-2">
      <StatusGlyph status={ref.status} />
      <Mono className="shrink-0">{ref.id}</Mono>
      <button
        type="button"
        onClick={() => useShellStore.getState().openTask(ref.id)}
        className="min-w-0 flex-1 truncate text-left text-card-title text-text-primary hover:text-primary"
        title={`打开 ${ref.id} · ${statusLabel(ref.status)}`}
      >
        {ref.title}
      </button>
      <Badge tone={ref.type === 'relates' ? 'soft' : 'neutral'} className="shrink-0">
        {labelOf(DEPENDENCY_TYPE_LABEL, ref.type)}
      </Badge>
      {removable ? (
        <button
          type="button"
          aria-label={`移除与 ${ref.id} 的依赖`}
          title="移除依赖"
          onClick={() => remove.mutate(ref.dep_id)}
          className="shrink-0 rounded-tag p-1 text-text-tertiary opacity-0 transition-opacity duration-140 ease-settle hover:bg-status-failed-soft hover:text-status-failed focus-visible:opacity-100 group-hover:opacity-100"
        >
          <Trash2 className="size-3.5" aria-hidden />
        </button>
      ) : null}
    </li>
  );
}

interface PickerProps {
  taskId: string;
  preset: { type: DependencyType } | null;
  existing: DependencyRef[];
  onClose: () => void;
}

/** 原型 8.2 添加依赖弹窗：搜索 → 选一条 → 选类型 → 添加；环检测的链路就地显示。 */
function DependencyPickerDialog({ taskId, preset, existing, onClose }: PickerProps) {
  const [keyword, setKeyword] = useState('');
  const [debounced, setDebounced] = useState('');
  const [selected, setSelected] = useState<TaskListItem | null>(null);
  const [type, setType] = useState<DependencyType>('blocks');
  const add = useAddDependency(taskId);

  useEffect(() => {
    if (!preset) {
      setKeyword('');
      setDebounced('');
      setSelected(null);
      setType('blocks');
      return;
    }
    setType(preset.type);
  }, [preset]);

  useEffect(() => {
    const timer = setTimeout(() => setDebounced(keyword.trim()), 300);
    return () => clearTimeout(timer);
  }, [keyword]);

  const results = useTaskList({ keyword: debounced || undefined, page_size: 20 });

  const linked = useMemo(() => new Set(existing.map((item) => item.id)), [existing]);
  const candidates = (results.data?.items ?? []).filter(
    (item) => item.id !== taskId && !linked.has(item.id),
  );

  if (!preset) return null;

  const submit = () => {
    if (!selected) return;
    add.mutate(
      { depends_on: selected.id, type },
      {
        onSuccess: () => {
          setSelected(null);
          onClose();
        },
      },
    );
  };

  const errorText = add.isError ? dependencyCycleText(add.error) : null;

  return (
    <Dialog
      open
      onClose={onClose}
      title={type === 'blocks' ? '添加前置任务' : '添加关联任务'}
      footer={
        <>
          <Button size="sm" onClick={onClose} disabled={add.isPending}>
            取消
          </Button>
          <Button size="sm" variant="primary" loading={add.isPending} disabled={!selected} onClick={submit}>
            添加
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-3">
        <Input
          value={keyword}
          onChange={(event) => setKeyword(event.target.value)}
          placeholder="搜索任务 ID 或标题…"
          aria-label="搜索任务"
        />
        <div className="atb-scroll max-h-[280px] overflow-y-auto rounded-card border border-border">
          {results.isPending ? (
            <p className="px-3 py-3 text-aux text-text-tertiary">搜索中…</p>
          ) : candidates.length === 0 ? (
            <EmptyState
              className="m-2 border-0 py-4"
              title="没有可选任务"
              description="已建立依赖的任务与当前任务不会出现在候选里。"
            />
          ) : (
            <ul className="divide-y divide-border">
              {candidates.map((item) => (
                <li key={item.id}>
                  <button
                    type="button"
                    onClick={() => setSelected(item)}
                    className={`flex w-full items-center gap-2 px-3 py-2 text-left hover:bg-bg-muted ${
                      selected?.id === item.id ? 'bg-primary-light' : ''
                    }`}
                  >
                    <StatusGlyph status={item.status} />
                    <Mono className="shrink-0">{item.id}</Mono>
                    <span className="min-w-0 flex-1 truncate text-card-title text-text-primary">
                      {item.title}
                    </span>
                    <span className="shrink-0 text-aux text-text-tertiary">{statusLabel(item.status)}</span>
                    {selected?.id === item.id ? <X className="size-3.5 shrink-0 text-primary" aria-hidden /> : null}
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>

        <div>
          <p className="mb-1 text-card-title text-text-primary">依赖类型</p>
          <RadioGroup
            layout="row"
            value={type}
            onChange={(value) => setType(value as DependencyType)}
            options={[
              { value: 'blocks', label: '阻塞（必须完成）' },
              { value: 'relates', label: '关联（仅标记）' },
            ]}
          />
          <p className="mt-1 text-aux text-text-tertiary">{COPY_DEPENDENCY_HINT}</p>
        </div>

        {errorText ? <InlineError text={errorText} /> : null}
      </div>
    </Dialog>
  );
}

/** 5.8：服务端已经算好链路并拼进 `USER_COPY.dependencyCycle`，这里只把它换成本地文案口径。 */
function dependencyCycleText(error: unknown): string {
  const message = errorMessage(error);
  if (errorCodeOf(error) !== 'DEPENDENCY_CYCLE') return message;
  const chain = message.split('依赖关系形成环：')[1]?.split('，已取消保存')[0]?.trim();
  return chain ? COPY.dependencyCycle(chain) : message;
}
