import { Checkbox, Field, Input, Select, Switch, Textarea } from '@/components/ui';
import type { FieldDef, FieldType } from '@/api';
import { FIELD_TYPE_LABEL, PHASE_ONE_FIELD_TYPES, labelOf } from '@/lib/labels';
import { cn } from '@/lib/cn';

/**
 * 6.9.2 自定义字段的「展示」与「编辑」两处实现。
 *
 * 阶段一只渲染 5 类控件（`PHASE_ONE_FIELD_TYPES`：text / textarea / number / select / bool）；
 * `multiselect` / `date` / `url` 的控件属阶段二（6.9.1、17.2），本期**只读展示原值**，
 * 不给一个会写坏数据的输入框。值本身仍要看得见——20.2 末段的口径是「读得出来就显示」。
 */

export type CustomFieldValues = Record<string, unknown>;

/** 空 applies_to = 全部适用（6.9.2）；已停用（enabled=false）的字段不进表单。 */
export function applicableFieldDefs(defs: readonly FieldDef[], taskType: string): FieldDef[] {
  return defs
    .filter((def) => def.enabled)
    .filter((def) => def.applies_to.length === 0 || def.applies_to.includes(taskType))
    .sort((left, right) => left.sort_order - right.sort_order || left.label.localeCompare(right.label));
}

export function isPhaseOneControl(type: FieldType): boolean {
  return PHASE_ONE_FIELD_TYPES.includes(type);
}

/** 展示态：布尔给「是/否」，数组给顿号串，其余 `String(value)`。 */
export function formatFieldValue(def: FieldDef | undefined, value: unknown): string {
  if (value === undefined || value === null || value === '') return '—';
  if (def?.type === 'bool') return truthy(value) ? '是' : '否';
  if (Array.isArray(value)) return value.map(String).join('、');
  if (typeof value === 'boolean') return value ? '是' : '否';
  if (typeof value === 'object') return JSON.stringify(value);
  return String(value);
}

/**
 * 提交态：把控件里的空值统一成 `null`（服务端对 number/bool 不接受 `''`），
 * 必填字段留空就交给服务端 422，界面按 `custom_fields.<key>` 显示行内错误。
 */
export function toSubmitValue(def: FieldDef, raw: unknown): unknown {
  if (raw === '' || raw === undefined) return null;
  if (def.type === 'number') {
    const parsed = Number(raw);
    return Number.isFinite(parsed) ? parsed : raw;
  }
  if (def.type === 'bool') return truthy(raw);
  return raw;
}

function truthy(value: unknown): boolean {
  return value === true || value === 'true' || value === 1 || value === '1';
}

/** 表单草稿的形状：一律按字符串存，number/bool 在提交时转换（受控组件不来回换类型）。 */
export type FieldDraft = Record<string, string>;

export function draftFromValues(defs: readonly FieldDef[], values: CustomFieldValues): FieldDraft {
  const draft: FieldDraft = {};
  for (const def of defs) {
    const value = values[def.key];
    if (value === undefined || value === null) {
      draft[def.key] = def.type === 'bool' ? 'false' : '';
    } else if (Array.isArray(value)) {
      draft[def.key] = value.map(String).join(',');
    } else if (def.type === 'bool') {
      draft[def.key] = truthy(value) ? 'true' : 'false';
    } else {
      draft[def.key] = String(value);
    }
  }
  return draft;
}

export interface CustomFieldControlProps {
  def: FieldDef;
  value: string;
  onChange: (value: string) => void;
  error?: string;
}

/** 5 类控件的渲染分发（20.10 的类型集合）。阶段二的三类在这里直接返回只读说明。 */
export function CustomFieldControl({ def, value, onChange, error }: CustomFieldControlProps) {
  const id = `cf-${def.key}`;
  const options = Array.isArray(def.options) ? def.options : [];
  const bounds = def.options && !Array.isArray(def.options) ? def.options : {};

  if (!isPhaseOneControl(def.type)) {
    return (
      <p className="text-aux text-text-tertiary">
        「{labelOf(FIELD_TYPE_LABEL, def.type)}」类型的控件在阶段二提供（6.9.1），当前值只读展示。
      </p>
    );
  }

  return (
    <Field
      label={def.label}
      required={def.required}
      htmlFor={id}
      error={error}
      hint={error ? undefined : hintFor(def, bounds)}
    >
      {def.type === 'textarea' ? (
        <Textarea id={id} rows={3} value={value} invalid={Boolean(error)} onChange={(event) => onChange(event.target.value)} />
      ) : def.type === 'number' ? (
        <Input
          id={id}
          type="number"
          min={bounds.min}
          max={bounds.max}
          value={value}
          invalid={Boolean(error)}
          onChange={(event) => onChange(event.target.value)}
        />
      ) : def.type === 'select' ? (
        <Select
          id={id}
          value={value}
          invalid={Boolean(error)}
          options={[{ value: '', label: '（未选择）' }, ...options.map((item) => ({ value: item, label: item }))]}
          onChange={(event) => onChange(event.target.value)}
        />
      ) : def.type === 'bool' ? (
        <span className="flex items-center gap-2">
          <Switch
            checked={truthy(value)}
            onChange={(checked) => onChange(checked ? 'true' : 'false')}
            label={`${def.label}：${truthy(value) ? '是' : '否'}`}
          />
          <span className="text-aux text-text-secondary">{truthy(value) ? '是' : '否'}</span>
        </span>
      ) : (
        <Input
          id={id}
          value={value}
          invalid={Boolean(error)}
          maxLength={200}
          onChange={(event) => onChange(event.target.value)}
        />
      )}
    </Field>
  );
}

function hintFor(def: FieldDef, bounds: { min?: number; max?: number }): string | undefined {
  if (def.type === 'number' && (bounds.min !== undefined || bounds.max !== undefined)) {
    return `取值范围 ${bounds.min ?? '-∞'} ~ ${bounds.max ?? '+∞'}`;
  }
  if (def.default_value !== null && def.default_value !== undefined && def.default_value !== '') {
    return `默认值：${def.default_value}`;
  }
  return undefined;
}

/** 标签编辑器：已选的画成 chip，候选来自 20.3 的实时聚合（词表已删的历史值也照样保留）。 */
export interface TagEditorProps {
  value: string[];
  candidates: string[];
  onChange: (value: string[]) => void;
  className?: string;
}

export function TagEditor({ value, candidates, onChange, className }: TagEditorProps) {
  const rest = candidates.filter((item) => !value.includes(item));
  return (
    <div className={cn('flex flex-col gap-2', className)}>
      <div className="flex flex-wrap items-center gap-1.5">
        {value.map((tag) => (
          <span
            key={tag}
            className="inline-flex items-center gap-1 rounded-tag bg-primary-light px-1.5 py-px text-badge text-primary"
          >
            {tag}
            <button
              type="button"
              aria-label={`移除标签 ${tag}`}
              className="text-text-tertiary hover:text-status-failed"
              onClick={() => onChange(value.filter((item) => item !== tag))}
            >
              ×
            </button>
          </span>
        ))}
        {value.length === 0 ? <span className="text-aux text-text-tertiary">无标签</span> : null}
      </div>
      <div className="flex items-center gap-2">
        <Input
          list="atb-tag-candidates"
          placeholder="输入后回车添加"
          className="max-w-[220px]"
          onKeyDown={(event) => {
            const target = event.target as HTMLInputElement;
            if (event.key !== 'Enter' || !target.value.trim()) return;
            event.preventDefault();
            const next = target.value.trim();
            if (!value.includes(next)) onChange([...value, next]);
            target.value = '';
          }}
        />
        <datalist id="atb-tag-candidates">
          {rest.map((tag) => (
            <option key={tag} value={tag} />
          ))}
        </datalist>
      </div>
    </div>
  );
}

/** `required_capabilities` 的编辑：20.5 的匹配规则是 `task.required_capabilities ⊆ token.capabilities`。 */
export function CapabilityEditor({
  value,
  onChange,
}: {
  value: string[];
  onChange: (value: string[]) => void;
}) {
  return (
    <div className="flex flex-col gap-2">
      <CheckboxRowList value={value} onChange={onChange} />
      <Input
        placeholder="形如 language:java、repo:order-service，回车追加"
        onKeyDown={(event) => {
          const target = event.target as HTMLInputElement;
          if (event.key !== 'Enter' || !target.value.trim()) return;
          event.preventDefault();
          const next = target.value.trim();
          if (!value.includes(next)) onChange([...value, next]);
          target.value = '';
        }}
      />
    </div>
  );
}

function CheckboxRowList({ value, onChange }: { value: string[]; onChange: (value: string[]) => void }) {
  if (value.length === 0) {
    return <p className="text-aux text-text-tertiary">未声明能力：任何 Agent 都能领到这个任务（20.5）。</p>;
  }
  return (
    <div className="flex flex-wrap gap-x-4 gap-y-1">
      {value.map((item) => (
        <Checkbox
          key={item}
          label={item}
          checked
          onChange={() => onChange(value.filter((each) => each !== item))}
        />
      ))}
    </div>
  );
}
