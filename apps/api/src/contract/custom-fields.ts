import { z } from 'zod';
import type { FieldType } from './enums';

/**
 * 20.10 自定义字段值契约。`options` 列在 select/multiselect 下是候选值数组，
 * 在 number 下可以是 `{min,max}` 约束对象——两种形态都在这里处理。
 */
export type FieldOptions = string[] | { min?: number; max?: number } | null;

export interface FieldDefLike {
  key: string;
  label: string;
  type: FieldType;
  required: boolean;
  options: FieldOptions;
  appliesTo: string[];
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function candidateOptions(options: FieldOptions): string[] {
  return Array.isArray(options) ? options : [];
}

export function numberBounds(options: FieldOptions): { min?: number; max?: number } {
  if (options && !Array.isArray(options)) return { min: options.min, max: options.max };
  return {};
}

const valueSchemas: Record<FieldType, z.ZodTypeAny> = {
  text: z.string().max(200),
  textarea: z.string().max(5000),
  number: z.number(),
  date: z.string().regex(DATE_RE, '需为 YYYY-MM-DD'),
  bool: z.boolean(),
  url: z.string().regex(/^https?:\/\//i, '需以 http(s):// 开头'),
  select: z.string(),
  multiselect: z.array(z.string()),
};

export interface ValueIssue {
  key: string;
  message: string;
}

/** 空值语义：必填字段不接受空串/空数组；非必填字段允许整体缺省。 */
export function validateFieldValue(
  def: FieldDefLike,
  value: unknown,
  opts: { present: boolean },
): ValueIssue | null {
  const fail = (message: string): ValueIssue => ({ key: def.key, message });

  if (value === undefined || value === null) {
    return def.required && opts.present ? fail('必填') : null;
  }

  const parsed = valueSchemas[def.type].safeParse(value);
  if (!parsed.success) {
    const first = parsed.error.issues[0];
    return fail(first?.message ?? '值类型不符');
  }

  switch (def.type) {
    case 'text':
    case 'textarea': {
      const v = parsed.data as string;
      if (def.required && v.trim() === '') return fail('必填');
      return null;
    }
    case 'number': {
      const { min, max } = numberBounds(def.options);
      const v = parsed.data as number;
      if (!Number.isFinite(v)) return fail('需为有限数值');
      if (min !== undefined && v < min) return fail(`需 ≥ ${min}`);
      if (max !== undefined && v > max) return fail(`需 ≤ ${max}`);
      return null;
    }
    case 'select': {
      const v = parsed.data as string;
      const candidates = candidateOptions(def.options);
      if (v === '') return def.required ? fail('必填') : null;
      if (!candidates.includes(v)) return fail(`取值需在 ${candidates.join(' / ')} 之内`);
      return null;
    }
    case 'multiselect': {
      const v = [...new Set(parsed.data as string[])];
      const candidates = candidateOptions(def.options);
      if (def.required && v.length === 0) return fail('至少选一项');
      const bad = v.find((item) => !candidates.includes(item));
      if (bad !== undefined) return fail(`「${bad}」不在候选值内`);
      return null;
    }
    default:
      return null;
  }
}

export function normalizeMultiSelect(value: unknown): unknown {
  return Array.isArray(value) ? [...new Set(value.map(String))] : value;
}

/** 该字段是否适用于给定任务类型：空 applies_to = 全部适用（6.9.2）。 */
export function appliesToType(def: FieldDefLike, taskType: string): boolean {
  return def.appliesTo.length === 0 || def.appliesTo.includes(taskType);
}
