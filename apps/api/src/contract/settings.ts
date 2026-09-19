import { z } from 'zod';
import { DEFAULT_TASK_TYPES, LOG_LINES_MAX } from './enums';

/**
 * 20.9 settings 键总表：类型、区间、默认值与「热生效」标记的单一来源。
 * 端口不在此表（10.3 三级决定），未知 key 写入一律 422。
 */
export const SETTINGS_SPECS = {
  lease_ttl_minutes: { schema: z.number().int().min(1).max(1440), default: 30, hot: true },
  heartbeat_interval_seconds: {
    schema: z.number().int().min(30).max(600),
    default: 300,
    hot: true,
  },
  board_column_limit: { schema: z.number().int().min(10).max(200), default: 50, hot: true },
  auto_archive_days: { schema: z.number().int().min(0).max(365), default: 30, hot: true },
  artifact_max_mb: { schema: z.number().int().min(1).max(200), default: 20, hot: true },
  backup_time: {
    schema: z.union([z.literal('off'), z.string().regex(/^\d{2}:[0-5]\d$/)]),
    default: '03:00',
    hot: true,
  },
  backup_keep: { schema: z.number().int().min(1).max(30), default: 7, hot: false },
  log_retention_days: { schema: z.number().int().min(1).max(90), default: 14, hot: true },
  log_level: {
    schema: z.enum(['debug', 'info', 'warn', 'error']),
    default: 'info',
    hot: true,
  },
  task_types: {
    schema: z.array(z.string().min(1).max(16)).min(1).max(20),
    default: [...DEFAULT_TASK_TYPES],
    hot: true,
  },
  ui_theme: { schema: z.enum(['system', 'light', 'dark']), default: 'system', hot: true },
  review_reuse_last_opinion: { schema: z.boolean(), default: true, hot: true },
  // 0919 服务端市场对接：token 由 connect 时的 login 换取（密码不落库）。
  // url/username 保存供展示与重连；token 仅存本地单机 SQLite（见设置页提示）。
  cloud_enabled: { schema: z.boolean(), default: false, hot: true },
  cloud_url: { schema: z.string().max(500), default: '', hot: true },
  cloud_username: { schema: z.string().max(100), default: '', hot: true },
  cloud_token: { schema: z.string().max(2000), default: '', hot: true },
} as const satisfies Record<string, { schema: z.ZodTypeAny; default: unknown; hot: boolean }>;

export type SettingsKey = keyof typeof SETTINGS_SPECS;
export type Settings = { [K in SettingsKey]: z.infer<(typeof SETTINGS_SPECS)[K]['schema']> };

export const DEFAULT_SETTINGS = Object.fromEntries(
  Object.entries(SETTINGS_SPECS).map(([key, spec]) => [key, spec.default]),
) as unknown as Settings;

export function isSettingsKey(key: string): key is SettingsKey {
  return Object.prototype.hasOwnProperty.call(SETTINGS_SPECS, key);
}

/** settings.value 一律 JSON 文本（20.9）。库里存的值不合法时回落默认值，不让读路径崩。 */
export function decodeSetting<T extends SettingsKey>(key: T, raw: string): Settings[T] {
  const spec = SETTINGS_SPECS[key];
  try {
    return spec.schema.parse(JSON.parse(raw)) as Settings[T];
  } catch {
    return spec.default as Settings[T];
  }
}

export function encodeSetting(value: unknown): string {
  return JSON.stringify(value);
}

/** 按 key 取值域校验；返回归一后的值，或第一处不合法的原因。 */
export function validateSetting(
  key: SettingsKey,
  value: unknown,
): { ok: true; value: unknown } | { ok: false; message: string } {
  const spec = SETTINGS_SPECS[key] as { schema: z.ZodTypeAny };
  const parsed = spec.schema.safeParse(value);
  if (parsed.success) return { ok: true, value: parsed.data };
  return { ok: false, message: parsed.error.issues[0]?.message ?? '取值越界' };
}

/** 20.6 产物大小上限由 settings 决定，日志行数上限是常量（20.8）。 */
export const ARTIFACT_RUN_TOTAL_MAX_BYTES = 200 * 1024 * 1024;
export const LOG_LINES_LIMIT = LOG_LINES_MAX;
