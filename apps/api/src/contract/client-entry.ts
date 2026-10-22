/**
 * 客户端入口（Rules + Skills）契约。
 *
 * 下面四个词表与迁移 `0025_client_entries/migration.sql` 的 CHECK 同值：
 * 改这里必须同步迁移（SQL 是权威 DDL），反之亦然。
 */
import { z } from 'zod';

/** 六家客户端。`claude_code` 用下划线，与目录/适配器文件名保持同一口径。 */
export const CLIENT_IDS = ['qoder', 'cursor', 'cline', 'windsurf', 'claude_code', 'codex'] as const;
export type ClientId = (typeof CLIENT_IDS)[number];

/** 写入作用域：项目级需要用户显式选目录；用户级只写固定白名单根。 */
export const CLIENT_ENTRY_SCOPES = ['project', 'user'] as const;
export type ClientEntryScope = (typeof CLIENT_ENTRY_SCOPES)[number];

/** 两类资产：入口规则（always-on 短文本）与操作技能（按需加载的手册）。 */
export const CLIENT_ENTRY_ASSETS = ['rule', 'skill'] as const;
export type ClientEntryAsset = (typeof CLIENT_ENTRY_ASSETS)[number];

/** 台账状态：installed=与台账一致 / drifted=被改过 / missing=文件不在了 / error=最近一次操作失败。 */
export const CLIENT_ENTRY_STATUSES = ['installed', 'drifted', 'missing', 'error'] as const;
export type ClientEntryStatus = (typeof CLIENT_ENTRY_STATUSES)[number];

/** 模板版本：升级模板时 +1，用于校验时提示 `update_available`（不自动写盘）。 */
export const CLIENT_ENTRY_TEMPLATE_VERSION = 1;

/** 托管块标记：安装时成对写入，卸载/校验只认这一对；不成对即 conflict/drifted。 */
export const CLIENT_ENTRY_MARKER_BEGIN = '<!-- jarvis-workbench:managed:begin -->';
export const CLIENT_ENTRY_MARKER_END = '<!-- jarvis-workbench:managed:end -->';

/**
 * `wake_probe` 的落库口（实现放在 client-entry 模块，接口留在 contract，
 * 避免 mcp ↔ client-entry 的模块类型环）。token 信息由鉴权上下文补，均可缺省。
 */
export interface WakeProbeRecorder {
  record(input: {
    source?: string;
    tokenId?: string;
    tokenName?: string;
  }): Promise<void>;
}

/** 唤醒来源标识的最大长度（与迁移/工具入参的 32 字口径一致）。 */
const WAKE_SOURCE_MAX = 32;

/**
 * MCP 工具入参 `source` 的清洗：非字符串/空串 → undefined；剔除 CR/LF/TAB（避免脏日志与注入），
 * 首尾空白一并去掉，最后截断到 32 字符。本切片只导出函数，工具接线在后续切片。
 */
export function sanitizeWakeSource(input: unknown): string | undefined {
  if (typeof input !== 'string') return undefined;
  const cleaned = input.replace(/[\r\n\t]/g, '').trim();
  if (!cleaned) return undefined;
  return cleaned.slice(0, WAKE_SOURCE_MAX);
}

/**
 * 预览/安装的计划入参。`assets` 缺省时由 service 按客户端能力决定（不支持 skill 的端不补）；
 * 显式传入则去重后按清单执行，空数组表示“什么都不装”（由 service 决定是否拒绝）。
 */
export const clientEntryPlanSchema = z.object({
  client: z.enum(CLIENT_IDS),
  scope: z.enum(CLIENT_ENTRY_SCOPES),
  workspace: z.string().trim().min(1).optional(),
  assets: z
    .array(z.enum(CLIENT_ENTRY_ASSETS))
    .transform((list) => [...new Set(list)])
    .optional(),
});
export type ClientEntryPlanInput = z.infer<typeof clientEntryPlanSchema>;

/**
 * 安装入参：计划字段 + `plan_hash`（预览时生成，install 重新计划后比对，不一致回 PLAN_STALE）
 * + `confirm: true`（绕过用户确认的写入一律拒绝）+ Windsurf 超限时的显式豁免开关。
 */
export const clientEntryInstallSchema = clientEntryPlanSchema.extend({
  plan_hash: z.string().trim().min(1),
  confirm: z.literal(true),
  allow_over_limit: z.boolean().optional(),
});
export type ClientEntryInstallInput = z.infer<typeof clientEntryInstallSchema>;

/** 校验入参：不传 ids 表示校验全部台账行；传了就只重读这些 id。 */
export const clientEntryVerifySchema = z.object({
  ids: z.array(z.string().trim().min(1)).optional(),
});
export type ClientEntryVerifyInput = z.infer<typeof clientEntryVerifySchema>;

/** 卸载入参：同样要求显式确认（只删本应用写入的内容，用户内容不动）。 */
export const clientEntryUninstallSchema = z.object({
  confirm: z.literal(true),
});
export type ClientEntryUninstallInput = z.infer<typeof clientEntryUninstallSchema>;

/** 自测查询：`since` 为 ISO 时间戳，缺省时由 service 取最近 N 条。 */
export const clientEntrySelfTestQuerySchema = z.object({
  since: z
    .union([z.string().datetime({ offset: true }), z.string().datetime()])
    .optional(),
});
export type ClientEntrySelfTestQuery = z.infer<typeof clientEntrySelfTestQuerySchema>;
