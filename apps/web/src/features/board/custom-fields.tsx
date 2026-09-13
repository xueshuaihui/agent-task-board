import type { FieldDef } from '@/api/types';
import { FIELD_TYPE_LABEL, PHASE_ONE_FIELD_TYPES, labelOf } from '@/lib/labels';
import { Checkbox, Field, Input, Select, Textarea } from '@/components/ui';

/**
 * 6.9 自定义字段的看板侧控件（阶段一 5 类：`text`/`textarea`/`number`/`select`/`bool`，
 * 见 `lib/labels.ts` 的 PHASE_ONE_FIELD_TYPES）。
 *
 * 这里只挡空值：枚举、长度、格式一律交服务端 `422 VALIDATION_FAILED`，
 * `details[]` 按 `custom_fields.<key>` 回填到对应控件（原型 8.1「必填」行）。
 */
export type CustomValues = Record<string, unknown>;

/** 20.2 `applies_to`：空数组 = 适用全部类型（与后端 `appliesToType()` 同一语义）。 */
export function applicableDefs(defs: readonly FieldDef[], taskType: string): FieldDef[] {
  return defs
    .filter((def) => def.enabled && (def.applies_to.length === 0 || def.applies_to.includes(taskType)))
    .sort((a, b) => a.sort_order - b.sort_order || a.label.localeCompare(b.label));
}

export function requiredDefs(defs: readonly FieldDef[], taskType: string): FieldDef[] {
  return applicableDefs(defs, taskType).filter((def) => def.required);
}

export function cardDefs(defs: readonly FieldDef[], taskType: string): FieldDef[] {
  return applicableDefs(defs, taskType).filter((def) => def.show_on_card && !def.required);
}

/** 提交前归一：空串/未触碰的字段不发送，数字转 JSON number（20.10 要求 number 而非字符串）。 */
export function toSubmitValues(defs: readonly FieldDef[], values: CustomValues): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const def of defs) {
    const raw = values[def.key];
    if (raw === undefined || raw === null || raw === '') continue;
    if (def.type === 'number') {
      const parsed = Number(raw);
      if (Number.isFinite(parsed)) result[def.key] = parsed;
      else result[def.key] = raw; // 交给服务端回 422，不在前端改判
      continue;
    }
    if (def.type === 'bool') {
      result[def.key] = raw === true || raw === 'true';
      continue;
    }
    if (!PHASE_ONE_FIELD_TYPES.includes(def.type)) continue; // 阶段二控件的字段不提交
    result[def.key] = typeof raw === 'string' ? raw.trim() : raw;
  }
  return result;
}

export function selectOptions(def: FieldDef): { value: string; label: string }[] {
  const options = Array.isArray(def.options) ? def.options : [];
  return options.map((option) => ({ value: option, label: option }));
}

export interface CustomFieldInputsProps {
  defs: readonly FieldDef[];
  values: CustomValues;
  /** 键为字段 key，值取服务端 `details[].message`。 */
  errors: Record<string, string>;
  onChange: (key: string, value: unknown) => void;
}

export function CustomFieldInputs({ defs, values, errors, onChange }: CustomFieldInputsProps) {
  if (defs.length === 0) return null;
  return (
    <div className="flex flex-col gap-3">
      {defs.map((def) => {
        const error = errors[def.key];
        const id = `cf-${def.key}`;
        const phaseTwo = !PHASE_ONE_FIELD_TYPES.includes(def.type);
        if (def.type === 'bool' && !phaseTwo) {
          return (
            <Field key={def.key} label={def.label} required={def.required} error={error} htmlFor={id}>
              <Checkbox
                id={id}
                checked={values[def.key] === true}
                onChange={(event) => onChange(def.key, event.target.checked)}
                label="是"
              />
            </Field>
          );
        }
        if (def.type === 'select' && !phaseTwo) {
          return (
            <Field key={def.key} label={def.label} required={def.required} error={error} htmlFor={id}>
              <Select
                id={id}
                invalid={Boolean(error)}
                placeholder="请选择"
                value={typeof values[def.key] === 'string' ? (values[def.key] as string) : ''}
                options={selectOptions(def)}
                onChange={(event) => onChange(def.key, event.target.value)}
              />
            </Field>
          );
        }
        if (phaseTwo) {
          return (
            <Field
              key={def.key}
              label={def.label}
              required={def.required}
              error={error}
              hint={`${labelOf(FIELD_TYPE_LABEL, def.type)}控件属阶段二（17.2），当前无法填写`}
            >
              <Input id={id} disabled placeholder="阶段二控件" />
            </Field>
          );
        }
        if (def.type === 'textarea') {
          return (
            <Field key={def.key} label={def.label} required={def.required} error={error} htmlFor={id}>
              <Textarea
                id={id}
                invalid={Boolean(error)}
                rows={2}
                value={typeof values[def.key] === 'string' ? (values[def.key] as string) : ''}
                onChange={(event) => onChange(def.key, event.target.value)}
              />
            </Field>
          );
        }
        return (
          <Field key={def.key} label={def.label} required={def.required} error={error} htmlFor={id}>
            <Input
              id={id}
              type={def.type === 'number' ? 'number' : 'text'}
              invalid={Boolean(error)}
              value={values[def.key] === undefined || values[def.key] === null ? '' : String(values[def.key])}
              onChange={(event) => onChange(def.key, event.target.value)}
            />
          </Field>
        );
      })}
    </div>
  );
}
