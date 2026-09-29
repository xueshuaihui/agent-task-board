import { z } from 'zod';
import { AGENT_CONFIRMATION_MODES, DEFAULT_TASK_TYPES, LOG_LINES_MAX, REVIEW_MODES } from './enums';

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
  // 任务审核方式可配置（草案 §3.1）：建任务未显式选 review_mode 时的全局兜底；
  // 取值词表与迁移 0020 的 tasks.review_mode CHECK 同值（REVIEW_MODES）。
  default_review_mode: { schema: z.enum(REVIEW_MODES), default: 'human', hot: true },
  // ---- 自动审核器·审核批次任务四键（草案 §3.5，落点即本段；§5.15 的文案 ⑲–㉒ 在 B4 进设置页）----
  // 四键都 hot: true；改动只作用于**之后**新建/追加的批次与该批次的后续轮次，已在跑的批次本轮口径不变
  // （§3.5 末段）。complete 分流前一次性取齐，且必须在 $transaction 外取（§7 约束 1、C9 死锁实证）。
  // ⑲ 开＝任务进入待审核时自动挂进审核批次；关＝只标记为自动轨，由你在审核页打包（§4.1 第 ② 步）。
  review_auto_dispatch: { schema: z.boolean(), default: true, hot: true },
  // ⑳ 一支审核批次最多覆盖几支任务（1–20，越界 422）；建批与追加都校验，事务内 count（§3.5/C9）。
  review_batch_max_targets: { schema: z.number().int().min(1).max(20), default: 5, hot: true },
  // ㉑ **对象级** Agent 结论数上限（1–10，越界 422）：预算记在被审对象身上而不是批次的 run_count，
  // 否则「驳回→重跑→另建新批次」会把上限清零（C2/N15：同一预算池累计、跨批次跨重跑都不重置）。
  review_max_rounds: { schema: z.number().int().min(1).max(10), default: 3, hot: true },
  // ㉒ 判据技能 id：建批时写进批次任务的 skills，随认领载荷下发正文（P3）。'' = 不绑判据。
  // **不新增内置技能**（N14）：默认值指向既有内置 `skl_builtin_code-review`，避开 124/125 计数锁与
  // `.md` 终稿 + 分片重生成 + 回填的整条链。技能存在性校验（`VALIDATION_FAILED`）属于后续片。
  review_rubric_skill: { schema: z.string().max(64), default: 'skl_builtin_code-review', hot: true },
  // v0.0.4 W8 §8.2/§8.8「设置 / Agent 创建任务」：创建模式（参数 > 此设置 > 默认轻确认）
  // 与轻确认卡片超时秒数（30s 是 PRD 口径；下限放宽只为测试演练超时路径）。
  agent_creation_mode: {
    schema: z.enum(AGENT_CONFIRMATION_MODES),
    default: 'light',
    hot: true,
  },
  light_confirm_timeout_seconds: { schema: z.number().int().min(1).max(300), default: 30, hot: true },
  // v0.0.4 #46「贾维斯唤醒词 MCP 工作模式」：唤醒词的监测在客户端对话里，服务端把措辞
  // 经 initialize 的 instructions 与每次工具响应的模式行下发——这里存的只是选哪一种。
  mcp_wake_mode: { schema: z.enum(['single', 'continuous']), default: 'single', hot: true },
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
