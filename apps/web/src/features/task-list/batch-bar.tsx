import { useMemo, useState } from 'react';
import { Archive, Tag, X } from 'lucide-react';
import { motion, useReducedMotion } from 'motion/react';
import { api, qk, useApiMutation, useTags } from '@/api';
import type { BatchResult, TaskListItem, TaskStatus } from '@/api/types';
import { springs, transitions } from '@/lib/motion';
import {
  Badge,
  Button,
  Dialog,
  Input,
  Menu,
  MenuCaret,
  Table,
  TBody,
  TD,
  TH,
  THead,
  TR,
  Tooltip,
  MonoCell,
} from '@/components/ui';
import type { MenuItem } from '@/components/ui';
import { statusLabel } from '@/lib/labels';
import { failuresOf, failureText, type BatchFailure } from './reason';

/**
 * 原型 3.8 的批量条：`已选 N 项  [移动到 ▾] [打标签] [归档] [清除选择]`。
 *
 * 三条动作都打 `POST /tasks/batch/*`，服务端 `batch()` **逐条判定、不整体回滚**
 * （6.13 / 13 章），响应 `succeeded[]` / `skipped[{id, reason}]`：
 * 界面按「成功 N 条，跳过 M 条」汇总，并把每条失败原因单列在结果弹窗里，
 * 绝不做「整批失败就当作没发生」的处理——那样用户根本不知道哪些任务被跳过了。
 *
 * 批量条里没有「恢复归档」：13 章没开这个端点，4.3 操作表把恢复定为**单条**动作，
 * 所以已归档任务的恢复走行内操作，不在这里用 N 次单条请求凑一个假批量。
 *
 * 只保留 `移动到 需求池/待执行` 两个目标（4.5 矩阵里批量可安全直改的只有这两列）：
 * `REVIEW → BACKLOG/READY` 必须走审核表单（6.5 三字段必填），批量入口一旦代跑
 * 就等于给必填校验开了后门；`DONE`/`RUNNING` 行的移动会被服务端拒成 `ILLEGAL_TRANSITION`，
 * 那类拒绝照样在结果弹窗里逐条列出，不在前端假装能判。
 */

/** 13 章 `batchIdsSchema`：`ids` 上限 200，超了整批 422，所以前端先挡。 */
const BATCH_MAX = 200;
/** 20.3：标签 ≤16 字符、每任务 ≤10 个（基座没有镜像常量，这里按服务端契约写死）。 */
const TAG_MAX_LENGTH = 16;
const TAGS_MAX_PER_TASK = 10;

const TRANSITION_TARGETS: readonly TaskStatus[] = ['BACKLOG', 'READY'];

type BatchKind = 'transition' | 'archive' | 'tags';

interface BatchVars {
  kind: BatchKind;
  label: string;
  send: () => Promise<BatchResult>;
}

interface BatchOutcome {
  label: string;
  succeeded: string[];
  failures: BatchFailure[];
}

export interface BatchBarProps {
  /** 已选任务行（跨页选择由本页 store 持有行数据，所以这里能拿到标签候选）。 */
  rows: readonly TaskListItem[];
  /** 动作完成后回写选择集：只保留失败项，成功项已经不在原位置了。 */
  onKeep: (ids: string[]) => void;
}

export function BatchBar({ rows, onKeep }: BatchBarProps) {
  const ids = useMemo(() => rows.map((row) => row.id), [rows]);
  const [outcome, setOutcome] = useState<BatchOutcome | null>(null);
  const [tagsOpen, setTagsOpen] = useState(false);
  const tooMany = ids.length > BATCH_MAX;
  const reducedMotion = useReducedMotion();

  const run = useApiMutation<BatchVars, BatchResult>((vars) => vars.send(), {
    // 批量写动的是一堆任务，只能整片失效：看板 + 列表（`qk.tasksRoot` 盖住本页与审核页的表格）。
    invalidate: [qk.boardRoot, qk.tasksRoot],
    onSuccess: (data, vars) => {
      const failures = failuresOf(data);
      setOutcome({
        label: vars.label,
        succeeded: data?.succeeded ?? [],
        failures,
      });
      onKeep(failures.map((failure) => failure.id));
    },
  });
  const busy = run.isPending;

  const moveTo: MenuItem[] = TRANSITION_TARGETS.map((status) => ({
    id: status,
    label: `移动到「${statusLabel(status)}」`,
    hint: '逐条判定',
    onSelect: () =>
      run.mutate({
        kind: 'transition',
        label: `移动到${statusLabel(status)}`,
        send: () => api.tasks.batchTransition({ ids, to: status }),
      }),
  }));

  return (
    /* DESIGN §4：底部浮动胶囊条——fixed 居中不占文档流，胶囊本体吃点击、外层放行。 */
    <div className="pointer-events-none fixed inset-x-0 bottom-6 z-40 flex justify-center px-6">
      <motion.div
        initial={reducedMotion ? { opacity: 0 } : { opacity: 0, y: 16, scale: 0.97 }}
        animate={{ opacity: 1, y: 0, scale: 1 }}
        transition={reducedMotion ? { duration: 0 } : transitions.overlay}
        className="pointer-events-auto flex flex-wrap items-center gap-2 rounded-badge border border-border bg-bg-surface py-2 pl-4 pr-2 shadow-pop"
      >
        <span className="text-aux text-text-primary">
          已选{' '}
          <motion.span
            key={ids.length}
            initial={reducedMotion ? false : { scale: 0.6 }}
            animate={{ scale: 1 }}
            transition={springs.pop}
            className="inline-block font-mono tabular-nums"
          >
            {ids.length}
          </motion.span>{' '}
          项
        </span>
      {tooMany ? (
        <Tooltip content={`服务端单次最多 ${BATCH_MAX} 条，请分批处理`}>
          <Badge tone="outline" className="border-status-failed text-status-failed">
            超出上限
          </Badge>
        </Tooltip>
      ) : null}
      <div className="ml-auto flex flex-wrap items-center gap-2">
        <Menu
          width={236}
          groups={[{ label: '批量流转（4.5 矩阵）', items: moveTo }]}
          trigger={({ open, toggle }) => (
            <Button
              size="sm"
              disabled={tooMany || busy}
              aria-expanded={open}
              onClick={toggle}
              className="text-text-secondary"
            >
              移动到
              <MenuCaret open={open} />
            </Button>
          )}
        />
        <Button
          size="sm"
          disabled={tooMany || busy}
          className="text-text-secondary"
          icon={<Tag className="size-3.5" aria-hidden />}
          onClick={() => setTagsOpen(true)}
        >
          打标签
        </Button>
        <Button
          size="sm"
          disabled={tooMany || busy}
          loading={busy && run.variables?.kind === 'archive'}
          className="text-text-secondary"
          icon={<Archive className="size-3.5" aria-hidden />}
          onClick={() =>
            run.mutate({
              kind: 'archive',
              label: '批量归档',
              send: () => api.tasks.batchArchive({ ids }),
            })
          }
        >
          归档
        </Button>
        <Button size="sm" variant="ghost" onClick={() => onKeep([])}>
          清除选择
        </Button>
      </div>
      </motion.div>

      <TagsDialog
        open={tagsOpen}
        rows={rows}
        busy={busy}
        onClose={() => setTagsOpen(false)}
        onSubmit={(add, remove) => {
          setTagsOpen(false);
          run.mutate({
            kind: 'tags',
            label: '批量打标签',
            send: () => api.tasks.batchTags({ ids, add, remove }),
          });
        }}
      />

      <ResultDialog outcome={outcome} onClose={() => setOutcome(null)} />
    </div>
  );
}

/* ------------------------------------------------------------------ 打标签 */

function TagsDialog({
  open,
  rows,
  busy,
  onClose,
  onSubmit,
}: {
  open: boolean;
  rows: readonly TaskListItem[];
  busy: boolean;
  onClose: () => void;
  onSubmit: (add: string[], remove: string[]) => void;
}) {
  const tags = useTags();
  const [add, setAdd] = useState<string[]>([]);
  const [remove, setRemove] = useState<string[]>([]);
  const [entry, setEntry] = useState('');

  // 移除候选取已选行的标签并集：跨页选中的行也在本页 store 里，所以并集是全量的。
  const removable = useMemo(() => {
    const union = new Set<string>();
    for (const row of rows) for (const tag of row.tags) union.add(tag);
    return [...union].sort();
  }, [rows]);

  const tooLong = entry.trim().length > TAG_MAX_LENGTH;
  const conflict = add.filter((tag) => remove.includes(tag));
  const hints = [
    tooLong ? `标签最多 ${TAG_MAX_LENGTH} 个字符` : null,
    conflict.length > 0 ? `同一标签不能同时出现在新增与移除：${conflict.join('、')}` : null,
  ].filter((item): item is string => item !== null);
  const canSubmit = !busy && !tooLong && conflict.length === 0 && add.length + remove.length > 0;

  const commitEntry = () => {
    const value = entry.trim().slice(0, TAG_MAX_LENGTH);
    setEntry('');
    if (!value) return;
    setAdd((current) => (current.includes(value) ? current : [...current, value]));
    setRemove((current) => current.filter((item) => item !== value));
  };

  return (
    <Dialog
      open={open}
      onClose={onClose}
      title="批量打标签"
      footer={
        <>
          <Button onClick={onClose}>取消</Button>
          <Button
            variant="primary"
            disabled={!canSubmit}
            onClick={() => {
              onSubmit(add, remove);
              // 弹窗常驻挂载，不清就等于把上一批的标签带进下一次勾选。
              setAdd([]);
              setRemove([]);
              setEntry('');
            }}
            data-testid="submit-tags"
          >
            应用到 {rows.length} 项
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-4">
        <p className="text-aux text-text-secondary">
          服务端先加后删（13 章），每个任务最多 {TAGS_MAX_PER_TASK} 个标签，超出的按顺序丢弃；
          逐条判定，被拒绝的任务会在结果里单列。
        </p>

        <section className="flex flex-col gap-1.5">
          <h4 className="text-aux text-text-secondary">新增标签</h4>
          <div className="flex items-center gap-2">
            <Input
              aria-label="新标签名称"
              value={entry}
              placeholder={`输入后回车添加，≤${TAG_MAX_LENGTH} 字符`}
              invalid={tooLong}
              onChange={(event) => setEntry(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter') {
                  event.preventDefault();
                  commitEntry();
                }
              }}
            />
            <Button size="sm" onClick={commitEntry} disabled={!entry.trim()}>
              添加
            </Button>
          </div>
          <div className="flex flex-wrap gap-1.5">
            {(tags.data?.tags ?? [])
              .filter((tag) => !add.includes(tag))
              .slice(0, 14)
              .map((tag) => (
                <button
                  key={tag}
                  type="button"
                  className="rounded-tag border border-border px-1.5 py-px text-badge text-text-secondary hover:border-primary hover:text-primary"
                  onClick={() => {
                    setAdd((current) => [...current, tag]);
                    setRemove((current) => current.filter((item) => item !== tag));
                  }}
                >
                  + {tag}
                </button>
              ))}
          </div>
          <div className="flex flex-wrap gap-1.5">
            {add.map((tag) => (
              <Chip key={`add-${tag}`} tag={tag} tone="add" onDrop={() => setAdd((current) => current.filter((item) => item !== tag))} />
            ))}
            {add.length === 0 ? (
              <span className="text-aux text-text-tertiary">没有要新增的标签</span>
            ) : null}
          </div>
        </section>

        <section className="flex flex-col gap-1.5">
          <h4 className="text-aux text-text-secondary">移除已有标签</h4>
          <div className="flex flex-wrap gap-1.5">
            {removable.map((tag) => (
              <button
                key={`cand-${tag}`}
                type="button"
                className="rounded-tag border border-border px-1.5 py-px text-badge text-text-secondary hover:border-primary hover:text-primary"
                onClick={() => {
                  setRemove((current) => (current.includes(tag) ? current : [...current, tag]));
                  setAdd((current) => current.filter((item) => item !== tag));
                }}
              >
                − {tag}
              </button>
            ))}
            {removable.length === 0 ? (
              <span className="text-aux text-text-tertiary">已选任务当前都没有标签</span>
            ) : null}
          </div>
          <div className="flex flex-wrap gap-1.5">
            {remove.map((tag) => (
              <Chip
                key={`remove-${tag}`}
                tag={tag}
                tone="remove"
                onDrop={() => setRemove((current) => current.filter((item) => item !== tag))}
              />
            ))}
          </div>
        </section>

        {hints.length > 0 ? (
          <ul className="flex flex-col gap-1 rounded-control bg-status-failed-soft px-3 py-2">
            {hints.map((hint) => (
              <li key={hint} className="text-aux text-status-failed">
                {hint}
              </li>
            ))}
          </ul>
        ) : null}
      </div>
    </Dialog>
  );
}

function Chip({
  tag,
  tone,
  onDrop,
}: {
  tag: string;
  tone: 'add' | 'remove';
  onDrop: () => void;
}) {
  return (
    <button
      type="button"
      aria-label={`取消${tone === 'add' ? '新增' : '移除'}标签 ${tag}`}
      className={
        tone === 'add'
          ? 'inline-flex items-center gap-1 rounded-tag bg-primary-light px-1.5 py-px text-badge text-primary'
          : 'inline-flex items-center gap-1 rounded-tag border border-status-failed px-1.5 py-px text-badge text-status-failed line-through'
      }
      onClick={onDrop}
    >
      {tag}
      <X className="size-3" aria-hidden />
    </button>
  );
}

/* ---------------------------------------------------------------- 结果弹窗 */

/**
 * 6.13 / 原型 3.8：结果按「成功 N 条，跳过 M 条」汇总，跳过项逐条列原因。
 * `reason` 是服务端 `CODE: message`，文案统一走 `reason.ts`（4.5 文案表，不自行措辞）。
 */
function ResultDialog({
  outcome,
  onClose,
}: {
  outcome: BatchOutcome | null;
  onClose: () => void;
}) {
  if (!outcome) return null;
  return (
    <Dialog
      open
      onClose={onClose}
      title={`${outcome.label}结果`}
      footer={
        <Button variant="primary" onClick={onClose}>
          知道了
        </Button>
      }
    >
      <div className="flex flex-col gap-3">
        <p className="text-body text-text-primary" data-selectable>
          成功 {outcome.succeeded.length} 条，跳过 {outcome.failures.length} 条
          {outcome.failures.length > 0 ? '（逐条判定，不整体回滚）' : ''}
        </p>
        {outcome.failures.length > 0 ? (
          <Table>
            <THead>
              <TH className="w-[90px]">任务</TH>
              <TH>跳过原因</TH>
            </THead>
            <TBody>
              {outcome.failures.map((failure) => (
                <TR key={failure.id}>
                  <TD>
                    <MonoCell>{failure.id}</MonoCell>
                  </TD>
                  <TD className="text-text-secondary">{failureText(failure.reason)}</TD>
                </TR>
              ))}
            </TBody>
          </Table>
        ) : null}
        {outcome.succeeded.length > 0 ? (
          <p className="text-aux text-text-tertiary" data-selectable>
            已生效：{outcome.succeeded.join('、')}
          </p>
        ) : null}
        {outcome.failures.length > 0 ? (
          <p className="text-aux text-text-secondary">
            失败的任务仍保留勾选，改完条件可以直接重试。
          </p>
        ) : null}
      </div>
    </Dialog>
  );
}
