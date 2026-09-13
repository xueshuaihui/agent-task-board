import { useMemo, useState } from 'react';
import { Copy, Plus, Trash2 } from 'lucide-react';
import { Button, Dialog, IconButton, Input, Select, Textarea } from '@/components/ui';
import { errorMessage, fieldErrorsOf } from '@/api';
import type {
  FieldDef,
  Template,
  TemplateCreateInput,
  TemplatePatchInput,
  TemplatePreset,
} from '@/api/types';
import { PRIORITY_LABEL } from '@/lib/labels';
import { ChipEditor } from '../components/chip-editor';
import { ConfirmDialog } from '../components/confirm-dialog';
import {
  FormError,
  RowActions,
  SettingRow,
  SettingsTable,
  SettingSection,
  TabHeader,
} from '../components/settings-ui';
import {
  useCreateTemplate,
  useDeleteTemplate,
  useFieldDefs,
  usePatchTemplate,
  useSettingsWriter,
  useTemplates,
} from '../queries';
import { CAPABILITY_NAMESPACES, CAPABILITY_RE, FIELD_OPTION_MAX } from '../utils';

/**
 * 模板 Tab（8.5 / 原型 7.5 / PRD 6.11）。
 *
 * 预填集合与 6.11.1 一一对应，**不增设别的**（原型原话）：标题前缀、描述、类型、优先级、
 * 标签、所需能力、自定义字段默认值，加一个用于排列表顺序的 `sort_order`。
 * `due_offset_days` 契约里有、表单里没有——7.5 的图里没有这一行，本期不做入口。
 *
 * 「预填不是校验」（7.5）：这里存什么都不会锁住新建任务时的字段，
 * 所以失效预填（类型已删、字段已停用）在本页只做**提示 + 保存前挡住**，
 * 因为服务端 `assertPreset` 对这两种情况就是 422。
 */

const COLS = 'grid-cols-[minmax(0,220px)_minmax(0,1fr)_152px]';

const PRIORITIES = [0, 1, 2, 3] as const;

export function TemplatesTab() {
  const { settings } = useSettingsWriter();
  const templates = useTemplates();
  const defs = useFieldDefs();
  const create = useCreateTemplate();
  const patch = usePatchTemplate();
  const remove = useDeleteTemplate();

  const taskTypes = settings?.task_types ?? [];
  const items = templates.data?.items ?? [];
  const enabledDefs = useMemo(
    () => (defs.data?.items ?? []).filter((item) => item.enabled),
    [defs.data],
  );

  const [draft, setDraft] = useState<{ source: Template | null } | null>(null);
  const [removing, setRemoving] = useState<Template | null>(null);
  const [error, setError] = useState<string | null>(null);

  const errorText =
    error ??
    (create.error ? describeTemplateError(create.error) : null) ??
    (patch.error ? describeTemplateError(patch.error) : null);

  const confirmRemove = () => {
    if (!removing) return;
    remove.mutate(removing.id, { onSuccess: () => setRemoving(null) });
  };

  return (
    <div className="flex flex-col gap-4">
      <TabHeader
        title="模板"
        action={
          <Button
            variant="primary"
            icon={<Plus className="size-4" />}
            onClick={() => {
              setError(null);
              create.reset();
              patch.reset();
              setDraft({ source: null });
            }}
          >
            新建模板
          </Button>
        }
        description="模板只影响创建瞬间：任务上不记录来源模板，改了模板不回溯。"
      />

      <SettingSection bare>
        <SettingsTable
          cols={COLS}
          head={['名称', '预填字段', '操作']}
          items={items}
          rowKey={(item) => item.id}
          align="start"
          cells={(item) => [
            <span key="name" className="truncate text-text-primary">
              {item.name}
            </span>,
            <span key="preset" className="text-aux leading-relaxed text-text-secondary">
              {describePreset(item.preset, enabledDefs)}
            </span>,
            <RowActions key="actions">
              <Button
                size="sm"
                variant="ghost"
                onClick={() => {
                  setError(null);
                  create.reset();
                  patch.reset();
                  setDraft({ source: item });
                }}
              >
                编辑
              </Button>
              <Button
                size="sm"
                variant="ghost"
                icon={<Copy className="size-3.5" />}
                onClick={() => {
                  setError(null);
                  create.reset();
                  patch.reset();
                  setDraft({ source: { ...item, id: '', name: `${item.name} 副本` } });
                }}
              >
                复制
              </Button>
              <IconButton
                label={`删除 ${item.name}`}
                size="iconSm"
                icon={<Trash2 className="size-3.5" />}
                onClick={() => {
                  setError(null);
                  remove.reset();
                  setRemoving(item);
                }}
              />
            </RowActions>,
          ]}
          empty={
            <p className="text-aux text-text-secondary">
              还没有模板。新建后它会出现在「新建任务」的模板下拉里。
            </p>
          }
        />
      </SettingSection>

      {errorText ? <FormError>{errorText}</FormError> : null}

      {draft ? (
        <TemplateDialog
          source={draft.source}
          taskTypes={taskTypes}
          defs={enabledDefs}
          pending={create.isPending || patch.isPending}
          onClose={() => setDraft(null)}
          onSubmit={async (body) => {
            setError(null);
            try {
              if (body.id && body.patchBody) {
                await patch.mutateAsync({ id: body.id, body: body.patchBody });
              } else if (body.createBody) {
                await create.mutateAsync(body.createBody);
              }
              setDraft(null);
            } catch (caught) {
              setError(describeTemplateError(caught));
            }
          }}
        />
      ) : null}

      <ConfirmDialog
        open={removing !== null}
        title={`删除模板「${removing?.name ?? ''}」`}
        description="只影响此后新建的任务。"
        detail="任务不存模板外键，已按此模板建出的任务不受任何影响。"
        confirmText="删除"
        danger
        loading={remove.isPending}
        onConfirm={confirmRemove}
        onClose={() => setRemoving(null)}
      />
    </div>
  );
}

/* ------------------------------------------------------------- 弹窗 */

interface TemplateDialogProps {
  /** null = 新建；「复制」传的是源模板的浅拷贝（id 已清空、名称加了「副本」）。 */
  source: Template | null;
  taskTypes: readonly string[];
  defs: readonly FieldDef[];
  pending: boolean;
  onClose: () => void;
  onSubmit: (body: {
    id: string | null;
    createBody?: TemplateCreateInput;
    patchBody?: TemplatePatchInput;
  }) => Promise<void>;
}

function TemplateDialog({
  source,
  taskTypes,
  defs,
  pending,
  onClose,
  onSubmit,
}: TemplateDialogProps) {
  const preset = source?.preset ?? {};
  const [name, setName] = useState(source?.name ?? '');
  const [titlePrefix, setTitlePrefix] = useState(preset.title_prefix ?? '');
  const [description, setDescription] = useState(preset.description ?? '');
  const [type, setType] = useState(preset.type ?? taskTypes[0] ?? '');
  const [priority, setPriority] = useState(String(preset.priority ?? 3));
  const [tags, setTags] = useState<string[]>(preset.tags ?? []);
  const [capabilities, setCapabilities] = useState<string[]>(preset.required_capabilities ?? []);
  const [values, setValues] = useState<Record<string, string>>(
    () => toStringValues(preset.custom_fields, defs),
  );
  const [sortOrder, setSortOrder] = useState(String(source?.sort_order ?? 0));
  const [errors, setErrors] = useState<Record<string, string>>({});

  /** 「复制」走新建：源模板 id 被清掉，所以判编辑要看有没有真 id。 */
  const editing = Boolean(source?.id);

  const stale = useMemo(
    () => collectStale(preset, taskTypes, defs),
    // 表单里改过的项目以提交前重算为准，这里只报存量问题（7.5 的 ⚠ 提示）
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [preset, taskTypes, defs],
  );

  const submit = () => {
    const next: Record<string, string> = {};
    if (!name.trim()) next.name = '请填写模板名称';
    else if (name.trim().length > 64) next.name = '名称最多 64 字';
    if (!type) next.type = '请选择类型';
    const custom = buildCustomFields(values, defs, preset.custom_fields);
    if (custom.error) next.custom_fields = custom.error;
    setErrors(next);
    if (Object.keys(next).length > 0) return;

    const payload: TemplatePreset = {
      type,
      priority: Number(priority),
      ...(titlePrefix.trim() ? { title_prefix: titlePrefix.trim() } : {}),
      ...(description ? { description } : {}),
      ...(tags.length ? { tags } : {}),
      ...(capabilities.length ? { required_capabilities: capabilities } : {}),
      ...(Object.keys(custom.fields).length ? { custom_fields: custom.fields } : {}),
    };
    void onSubmit({
      id: source?.id ?? null,
      createBody: {
        name: name.trim(),
        preset: payload,
        sort_order: clampSort(sortOrder),
      },
      patchBody: {
        name: name.trim(),
        preset: payload,
        sort_order: clampSort(sortOrder),
      },
    });
  };

  return (
    <Dialog
      open
      onClose={onClose}
      title={editing ? `编辑模板「${source?.name ?? ''}」` : '新建模板'}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            取消
          </Button>
          <Button variant="primary" loading={pending} onClick={submit}>
            保存
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-4">
        {stale.length ? (
          <p className="rounded-control bg-status-running-soft px-3 py-2 text-aux text-text-primary">
            ⚠ 部分预填已失效，保存前需处理：
            {stale.map((item) => (
              <span key={item} className="mr-2">
                {item}
              </span>
            ))}
          </p>
        ) : null}

        <SettingRow label="名称" required width="fluid" error={errors.name}>
          <Input
            value={name}
            maxLength={64}
            invalid={Boolean(errors.name)}
            placeholder="缺陷修复"
            onChange={(event) => {
              setName(event.target.value);
              setErrors({ ...errors, name: '' });
            }}
          />
        </SettingRow>

        <SettingRow
          label="标题前缀"
          width="fluid"
          hint="建任务时拼在标题最前（如「【缺陷】登录页白屏」），可被用户改掉。"
        >
          <Input
            value={titlePrefix}
            maxLength={30}
            placeholder="【缺陷】"
            onChange={(event) => setTitlePrefix(event.target.value)}
          />
        </SettingRow>

        <SettingRow label="描述" width="fluid" hint="多行，支持 Markdown；预填进新建任务的描述框。">
          <Textarea
            rows={4}
            value={description}
            placeholder="复现步骤：\n1. …"
            onChange={(event) => setDescription(event.target.value)}
          />
        </SettingRow>

        <div className="flex flex-wrap gap-x-4 gap-y-3">
          <SettingRow label="类型" required width="narrow" error={errors.type}>
            <Select
              value={type}
              options={[
                ...[...new Set([...taskTypes, type].filter(Boolean))].map((item) => ({
                  value: item,
                  label: item,
                })),
              ]}
              onChange={(event) => {
                setType(event.target.value);
                setErrors({ ...errors, type: '' });
              }}
            />
          </SettingRow>

          <SettingRow label="优先级" required width="narrow">
            <Select
              value={priority}
              options={PRIORITIES.map((item) => ({
                value: String(item),
                label: `P${item} ${PRIORITY_LABEL[item as 0 | 1 | 2 | 3] ?? ''}`.trim(),
              }))}
              onChange={(event) => setPriority(event.target.value)}
            />
          </SettingRow>

          <SettingRow label="排序" width="narrow" hint="数字小者在前（0–999）。">
            <Input
              value={sortOrder}
              inputMode="numeric"
              onChange={(event) => setSortOrder(event.target.value)}
            />
          </SettingRow>
        </div>

        <SettingRow
          label="标签"
          width="fluid"
          hint="建任务时自动打上的标签；留空即不预填。"
        >
          <ChipEditor values={tags} max={20} maxEach={FIELD_OPTION_MAX} addLabel="添加标签" onChange={setTags} />
        </SettingRow>

        <SettingRow
          label="所需能力"
          width="fluid"
          hint={`格式 \`namespace:value\`（20.5）；命名空间：${CAPABILITY_NAMESPACES.join(' / ')}。`}
        >
          <ChipEditor
            values={capabilities}
            max={20}
            maxEach={64}
            addLabel="添加能力"
            placeholder="language:java"
            validate={(raw) =>
              CAPABILITY_RE.test(raw) ? null : '能力标识需为 namespace:value'
            }
            onChange={setCapabilities}
          />
        </SettingRow>

        <SettingRow
          label="自定义字段默认值"
          width="fluid"
          error={errors.custom_fields}
          hint="只列启用中的字段定义（7.5），值按 20.10 的类型契约取合法候选。"
        >
          {defs.length === 0 ? (
            <span className="inline-flex h-8 items-center text-aux text-text-tertiary">
              还没有启用的字段定义。
            </span>
          ) : (
            <div className="flex flex-col gap-2 py-1">
              {defs.map((def) => (
                <div key={def.id} className="flex items-center gap-2">
                  <span className="w-32 shrink-0 truncate text-aux text-text-secondary">
                    {def.label}
                  </span>
                  <div className="min-w-0 flex-1">
                    <DefaultValueControl
                      def={def}
                      value={values[def.key] ?? ''}
                      onChange={(next) => setValues({ ...values, [def.key]: next })}
                    />
                  </div>
                </div>
              ))}
            </div>
          )}
        </SettingRow>
      </div>
    </Dialog>
  );
}

/* ------------------------------------------------- 预填值的读写小件 */

function DefaultValueControl({
  def,
  value,
  onChange,
}: {
  def: FieldDef;
  value: string;
  onChange: (next: string) => void;
}) {
  if (def.type === 'bool') {
    return (
      <Select
        value={value}
        placeholder="不预填"
        options={[
          { value: 'true', label: '是' },
          { value: 'false', label: '否' },
        ]}
        onChange={(event) => onChange(event.target.value)}
      />
    );
  }
  if (def.type === 'select') {
    const candidates = Array.isArray(def.options) ? def.options : [];
    return (
      <Select
        value={value}
        placeholder="不预填"
        options={[
          ...[...new Set([...candidates, value].filter((item) => item !== ''))].map((item) => ({
            value: item,
            label: item,
          })),
        ]}
        onChange={(event) => onChange(event.target.value)}
      />
    );
  }
  return (
    <Input
      value={value}
      type={def.type === 'number' ? 'number' : 'text'}
      maxLength={def.type === 'text' ? 200 : 2000}
      placeholder="不预填"
      onChange={(event) => onChange(event.target.value)}
    />
  );
}

/** 存库的默认值可能是 number/boolean，表单只吃字符串：先摊平，缺 key 的与阶段二类型另存。 */
function toStringValues(
  stored: Record<string, unknown> | undefined,
  defs: readonly FieldDef[],
): Record<string, string> {
  const out: Record<string, string> = {};
  if (!stored) return out;
  for (const def of defs) {
    const raw = stored[def.key];
    if (raw === undefined || raw === null) continue;
    if (def.type === 'bool') out[def.key] = raw === true || raw === 'true' ? 'true' : 'false';
    else if (Array.isArray(raw)) out[def.key] = raw.join(',');
    else out[def.key] = String(raw);
  }
  return out;
}

function buildCustomFields(
  values: Record<string, string>,
  defs: readonly FieldDef[],
  stored: Record<string, unknown> | undefined,
): { fields: Record<string, unknown>; error: string | null } {
  const fields: Record<string, unknown> = {};
  // 表单没渲染出来的键要原样带回：`preset` 是整份替换（templates.service 注释），漏了就是丢数据。
  const rendered = new Set(defs.map((item) => item.key));
  for (const [key, value] of Object.entries(stored ?? {})) {
    if (!rendered.has(key)) fields[key] = value;
  }
  for (const def of defs) {
    const raw = (values[def.key] ?? '').trim();
    if (!raw) continue;
    if (def.type === 'number') {
      const parsed = Number(raw);
      if (!Number.isFinite(parsed)) {
        return { fields, error: `「${def.label}」需为数值` };
      }
      const bounds = def.options && !Array.isArray(def.options) ? def.options : {};
      if (bounds.min !== undefined && parsed < bounds.min) {
        return { fields, error: `「${def.label}」需 ≥ ${bounds.min}` };
      }
      if (bounds.max !== undefined && parsed > bounds.max) {
        return { fields, error: `「${def.label}」需 ≤ ${bounds.max}` };
      }
      fields[def.key] = parsed;
      continue;
    }
    if (def.type === 'bool') {
      fields[def.key] = raw === 'true';
      continue;
    }
    if (def.type === 'select' && Array.isArray(def.options) && !def.options.includes(raw)) {
      return { fields, error: `「${def.label}」的取值需在 ${def.options.join(' / ')} 之内` };
    }
    if (def.type === 'multiselect') {
      const list = raw.split(',').map((item) => item.trim()).filter(Boolean);
      const candidates = Array.isArray(def.options) ? def.options : [];
      const bad = list.find((item) => !candidates.includes(item));
      if (bad !== undefined) {
        return { fields, error: `「${def.label}」的「${bad}」不在候选值内` };
      }
      fields[def.key] = list;
      continue;
    }
    if (def.type === 'url' && !/^https?:\/\//i.test(raw)) {
      return { fields, error: `「${def.label}」需以 http(s):// 开头` };
    }
    if (def.type === 'date' && !/^\d{4}-\d{2}-\d{2}$/.test(raw)) {
      return { fields, error: `「${def.label}」需为 YYYY-MM-DD` };
    }
    fields[def.key] = raw;
  }
  return { fields, error: null };
}

/** 7.5 的「失效预填」：类型已从词表删除、或某个 custom_fields 的 key 已停用/被删。 */
function collectStale(
  preset: TemplatePreset,
  taskTypes: readonly string[],
  defs: readonly FieldDef[],
): string[] {
  const out: string[] = [];
  if (preset.type && !taskTypes.includes(preset.type)) {
    out.push(`类型「${preset.type}」已从词表删除`);
  }
  for (const key of Object.keys(preset.custom_fields ?? {})) {
    if (!defs.some((def) => def.key === key)) out.push(`字段「${key}」已停用或不存在`);
  }
  return out;
}

/** 列表的「预填字段」摘要列（原型 7.5）。 */
function describePreset(preset: TemplatePreset, defs: readonly FieldDef[]): string {
  const parts: string[] = [];
  if (preset.type) parts.push(`类型=${preset.type}`);
  if (preset.priority !== undefined) parts.push(`P${preset.priority}`);
  if (preset.title_prefix) parts.push(`前缀「${preset.title_prefix}」`);
  if (preset.description) parts.push('描述');
  if (preset.tags?.length) parts.push(`标签[${preset.tags.join('、')}]`);
  if (preset.required_capabilities?.length) {
    parts.push(`所需能力[${preset.required_capabilities.join(' ')}]`);
  }
  for (const [key, value] of Object.entries(preset.custom_fields ?? {})) {
    const def = defs.find((item) => item.key === key);
    const shown = Array.isArray(value) ? value.join('、') : String(value);
    parts.push(`${def?.label ?? key}=${shown}`);
  }
  return parts.length ? parts.join(' · ') : '（无预填项）';
}

function clampSort(raw: string): number {
  const parsed = Math.trunc(Number(raw));
  if (!Number.isFinite(parsed)) return 0;
  return Math.min(999, Math.max(0, parsed));
}

/** 422 的 `details.fields` 里带 `preset.type`、`preset.custom_fields.severity` 这类路径，直接摊出来。 */
function describeTemplateError(error: unknown): string {
  const fields = fieldErrorsOf(error);
  const parts = Object.entries(fields).map(([key, message]) => `${key}：${message}`);
  return parts.length ? `${errorMessage(error)}（${parts.join('；')}）` : errorMessage(error);
}
