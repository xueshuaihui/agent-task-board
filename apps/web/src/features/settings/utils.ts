import type { SelectOption } from '@/components/ui';
import type { FieldDef, FieldOptions } from '@/api/types';

/**
 * 设置页内部共用的小工具。正则与上限全部照抄契约（20.1 / 20.5 / 20.9 / 13 章），
 * 服务端是最终裁判：这里只是把明显不合法的输入在提交前挡住，错误文案与后端一致。
 */

/** 20.1 `custom_field_defs.key`：保存后不可改。 */
export const FIELD_KEY_RE = /^[a-z][a-z0-9_]{1,31}$/;
/** 20.5 能力标识 `namespace:value`，命名空间小写 ASCII。 */
export const CAPABILITY_RE = /^[a-z][a-z0-9_-]*:[^\s]+$/;
export const CAPABILITY_NAMESPACES = ['language:', 'framework:', 'repo:', 'tool:'] as const;
/** 13 章 Token 名称：界面与 Agent 配置里同源显示，所以限死小写。 */
export const TOKEN_NAME_RE = /^[a-z0-9][a-z0-9_-]*$/;
/** 20.3 词表项：单个 ≤ 16 字符；20.9 `task_types` 最少 1 个、最多 20 个。 */
export const TASK_TYPE_MAX = 16;
export const TASK_TYPE_LIST_MAX = 20;
/** 6.9.1 `label` ≤ 32；13 章选项 1–100 个、单个 ≤ 64。 */
export const FIELD_LABEL_MAX = 32;
export const FIELD_OPTION_MAX = 64;
/** 全表最多 2 个卡片字段（6.9.2）。 */
export const CARD_FIELD_MAX = 2;

export function clampText(value: string, max: number): string {
  return value.length > max ? value.slice(0, max) : value;
}

/**
 * 下拉档位 + 当前值：20.9 的区间比原型 7.2 的几档宽（如保留天数 1–90），
 * 库里存着一个不在档位里的值时， select 不能把它显示成别的数字。
 */
export function optionsWithCurrent(
  presets: readonly number[],
  current: number,
  format: (value: number) => string,
): SelectOption[] {
  const values = [...new Set([...presets, current])].sort((a, b) => a - b);
  return values.map((value) => ({ value: String(value), label: format(value) }));
}

/** 字段定义里读候选值（`options` 两种形态，20.10）。 */
export function selectOptions(options: FieldOptions | undefined): string[] {
  return Array.isArray(options) ? options : [];
}

/** 该字段能否上卡片：6.9.1 末行——`textarea` 在 248px 卡片上必然截断成噪声。 */
export function cardEligible(def: Pick<FieldDef, 'type'>): boolean {
  return def.type === 'text' || def.type === 'number' || def.type === 'select' || def.type === 'bool';
}

/** 审计详情列（7.7）：`before` → `after` 的压缩摘要，只挑真正变了的键。 */
export function auditSummary(before: unknown, after: unknown): string {
  const left = asRecord(before);
  const right = asRecord(after);
  if (left && right) {
    const parts: string[] = [];
    for (const [key, value] of Object.entries(right)) {
      if (!(key in left)) continue;
      if (same(left[key], value)) continue;
      parts.push(`${key}: ${short(left[key])} → ${short(value)}`);
      if (parts.length >= 2) break;
    }
    for (const [key, value] of Object.entries(right)) {
      if (parts.length >= 2) break;
      if (key in left || IGNORED_KEYS.has(key)) continue;
      parts.push(`${key}: ${short(value)}`);
    }
    if (parts.length) return parts.join(' · ');
  }
  if (before === null || before === undefined) return after === null || after === undefined ? '—' : short(after);
  if (after === null || after === undefined) return `${short(before)} → （已删除）`;
  if (typeof before !== 'object' || typeof after !== 'object') return `${short(before)} → ${short(after)}`;
  return '—';
}

/** 这些键每次流转都变，摆在摘要里等于没有信息。 */
const IGNORED_KEYS = new Set(['updated_at', 'created_at', 'before', 'after', 'id']);

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function same(left: unknown, right: unknown): boolean {
  return JSON.stringify(left ?? null) === JSON.stringify(right ?? null);
}

export function short(value: unknown): string {
  if (value === null || value === undefined) return '—';
  if (typeof value === 'boolean') return value ? '是' : '否';
  if (typeof value === 'object') {
    const text = JSON.stringify(value);
    return text.length > 40 ? `${text.slice(0, 40)}…` : text;
  }
  const text = String(value);
  return text.length > 40 ? `${text.slice(0, 40)}…` : text;
}

/** 审计行展开时的 JSON 原文（7.7：折叠为一行，展开才给全文）。 */
export function prettyJson(value: unknown): string {
  if (value === null || value === undefined) return '—';
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

/** 6.12.1「选中任务」：ID 之间允许逗号、空格或换行分隔。 */
export function parseTaskIds(raw: string): string[] {
  return [...new Set(raw.split(/[\s,，、]+/).map((item) => item.trim()).filter(Boolean))];
}

/** 备份文件名（9.3 / 13 章白名单）：不匹配的名字服务端直接 400，界面上也就无从恢复。 */
export function isBackupFileName(name: string): boolean {
  return /^atb-\d{8}-\d{6}\.db$/.test(name);
}
