/**
 * 数据契约的 TypeScript 镜像：取值集合以 PRD 二十章 + `apps/api/src/contract/enums.ts` 为准，
 * DTO 形状以 `apps/api/src/tasks/task.dto.ts` 与 13 章接口表为准。
 *
 * 为什么手写而不是 import 后端包：前端产物不该依赖 Nest 的编译链，也不该把 zod 带进浏览器。
 * 代价是两处要人肉同步——枚举只增不删（20.11），所以漂移只会发生在新增取值时，
 * 读路径又有 `labelOf()` 的「未知（原值）」兜底（20.2 末段），不会崩。
 */

/* ------------------------------------------------------------------ 枚举 */

export const TASK_STATUSES = [
  'BACKLOG',
  'READY',
  'RUNNING',
  // 8.4 人工块：Agent 执行到人工块时转人工阻塞，人工处理后回 READY 重新认领。
  'BLOCKED',
  'REVIEW',
  'DONE',
  'FAILED',
] as const;
export type TaskStatus = (typeof TASK_STATUSES)[number];

/** 4.1：看板固定六列、固定顺序，前端不重排。 */
export const BOARD_COLUMN_ORDER: readonly TaskStatus[] = TASK_STATUSES;

export type TaskPriority = 0 | 1 | 2 | 3;

export const RUN_STATUSES = ['RUNNING', 'SUCCESS', 'FAILED', 'ABANDONED'] as const;
export type RunStatus = (typeof RUN_STATUSES)[number];

export const TRIGGER_TYPES = ['agent_poll', 'manual_retry', 'auto_retry'] as const;
export type TriggerType = (typeof TRIGGER_TYPES)[number];

export const STOP_REASONS = ['user_stop', 'lease_expired', 'agent_reported'] as const;
export type StopReason = (typeof STOP_REASONS)[number];

export const REVIEW_CONCLUSIONS = ['APPROVE', 'REJECT'] as const;
export type ReviewConclusion = (typeof REVIEW_CONCLUSIONS)[number];

/** 2026-10-09 裁定：任务级审核方式只剩两枚——human 人审 / none 免审直通（「Agent 当审核方」的 auto 已整链移除）。 */
export const REVIEW_MODES = ['human', 'none'] as const;
export type ReviewMode = (typeof REVIEW_MODES)[number];

export const RETURN_TARGETS = ['BACKLOG', 'READY'] as const;
export type ReturnTarget = (typeof RETURN_TARGETS)[number];

export const DEPENDENCY_TYPES = ['blocks', 'relates'] as const;
export type DependencyType = (typeof DEPENDENCY_TYPES)[number];

export const AUTHOR_TYPES = ['user', 'agent', 'system'] as const;
export type AuthorType = (typeof AUTHOR_TYPES)[number];

export const COMMENT_TYPES = ['comment', 'log', 'status_change'] as const;
export type CommentType = (typeof COMMENT_TYPES)[number];

export const ARTIFACT_TYPES = [
  'diff',
  'image',
  'text',
  'log',
  'markdown',
  'json',
  'html',
  'pdf',
  'link',
  'file',
] as const;
export type ArtifactType = (typeof ARTIFACT_TYPES)[number];

export const NOTIFICATION_KINDS = [
  'review_pending',
  'run_failed',
  'lease_expired',
  'review_rejected',
  'task_unblocked',
] as const;
export type NotificationKind = (typeof NOTIFICATION_KINDS)[number];

// 与 apps/api/src/contract/enums.ts 的 AUDIT_ACTIONS 一一对应（v0.0.4 W1a 移除 account_*）。
// 少一项就在审计列表里渲染成「未知（xxx）」——审计页是这张表的唯一读者。
export const AUDIT_ACTIONS = [
  'task_create',
  'task_update',
  'task_transition',
  'task_stop',
  'task_delete',
  'task_archive',
  'archive_skipped',
  'run_claim',
  'run_writeback',
  'lease_expire',
  'review_submit',
  'dep_add',
  'dep_remove',
  'field_def_change',
  'template_change',
  'token_issue',
  'token_revoke',
  'token_use',
  'import',
  'export',
  'backup',
  'restore',
  // §21.2-3：数据目录一次性搬迁（服务端 action 名见 infra/data-dir-migration.ts）。
  'migration_completed',
  'settings_change',
  'group_change',
  // v0.0.4 W4 §5.6 r3：分组归档/反归档（服务端动作名统一 snake_case）。
  'group_archive',
  'group_unarchive',
  'pref_change',
  // v0.0.4 W6 §12.6：MCP 治理两条（agent/mcp-policy.service.ts 落库处）。
  'mcp_policy_check',
  'mcp_call',
  // v0.0.4 W7 §7.2 阶段 7：拆解会话的用户动作与超期系统动作（breakdown.service.ts）。
  'breakdown_confirm',
  'breakdown_cancel',
  'breakdown_timeout',
  // 客户端入口安装/卸载（client-entry.service.ts）。
  'client_entry_install',
  'client_entry_uninstall',
] as const;
export type AuditAction = (typeof AUDIT_ACTIONS)[number];

export const AUDIT_TARGET_TYPES = [
  'task',
  'run',
  'review',
  'dependency',
  'field_def',
  'template',
  'token',
  'settings',
  'data',
  // 客户端入口台账（安装/卸载的审计目标）。
  'client_entry',
] as const;
export type AuditTargetType = (typeof AUDIT_TARGET_TYPES)[number];

/** 20.10：8 类定义类型；阶段一只渲染其中 5 类控件（见 lib/labels.ts PHASE_ONE_FIELD_TYPES）。 */
export const FIELD_TYPES = [
  'text',
  'textarea',
  'number',
  'select',
  'multiselect',
  'date',
  'bool',
  'url',
] as const;
export type FieldType = (typeof FIELD_TYPES)[number];

/** `options` 两种形态：select/multiselect 是候选数组，number 可以是 `{min,max}` 约束。 */
export type FieldOptions = string[] | { min?: number; max?: number } | null;

/** 20.7 board 的视图预设；`status` 不在 board 的参数里（六列本身就是状态）。 */
export const BOARD_VIEWS = ['all', 'review', 'failed', 'claimable', 'blocked'] as const;
export type BoardView = (typeof BOARD_VIEWS)[number];

export const ARCHIVED_FILTERS = ['false', 'true', 'all'] as const;
export type ArchivedFilter = (typeof ARCHIVED_FILTERS)[number];

export const LIST_SORT_FIELDS = ['id', 'priority', 'status', 'created_at', 'updated_at'] as const;
export type ListSortField = (typeof LIST_SORT_FIELDS)[number];

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

/* --------------------------------------------------------------- 错误契约 */

/**
 * 13 章「统一错误码」表 + 网络层兜底 `NETWORK_ERROR`。UI 文案按 code 驱动（api/client.ts）。
 *
 * 这张表必须与服务端 `apps/api/src/contract/errors.ts` 的 `ERROR_STATUS` 逐键对齐：
 * 少一个键，那个码在 `client.ts` 的已知码判定里就落回 `UNKNOWN`，细化文案直接丢掉。
 * 对齐由 `apps/api/src/contract/__tests__/error-code-table.test.ts` 的闸守着（双向都判）。
 */
export const ERROR_CODES = [
  'UNAUTHORIZED',
  'FORBIDDEN',
  'NOT_FOUND',
  'VALIDATION_FAILED',
  'INVALID_PARAM',
  'ILLEGAL_TRANSITION',
  'TASK_NOT_RUNNING',
  'TASK_RUNNING',
  'TASK_GONE',
  // v0.0.4 §16.1：任务停在 BLOCKED/REVIEW/DONE/FAILED 这些「编辑窗口之外」的状态。
  'TASK_NOT_EDITABLE',
  'ARCHIVE_BLOCKED_BY_DEPENDENCY',
  'ARCHIVE_BLOCKED_BY_CHILDREN',
  'DEPENDENCY_CYCLE',
  'LEASE_EXPIRED',
  'LEASE_REVOKED',
  'ARTIFACT_TOO_LARGE',
  'ARTIFACT_LOST',
  'IMPORT_ID_CONFLICT',
  'FIELD_IN_USE',
  // 8 章技能管理：被任务绑定 / 同 ID 导入冲突 / 默认技能只读 / 引用自指与成环。
  'SKILL_BOUND',
  'SKILL_ID_CONFLICT',
  'SKILL_READONLY',
  'SKILL_REF_SELF',
  'SKILL_REF_CYCLE',
  'INVALID_BACKUP_NAME',
  'GROUP_LIMIT_REACHED',
  'GROUP_DEFAULT_PROTECTED',
  // v0.0.4 W4 §5.6：归档前置校验未过（context.remaining 带剩余任务数）；归档分组只读。
  'GROUP_NOT_ALL_DONE',
  'GROUP_ARCHIVED',
  'BACKUP_NOT_FOUND',
  // v0.0.4 W7 §7.7：拆解动作从表外状态发起（confirm 只允许 reviewing、cancel 只允许 receiving/reviewing）。
  'BREAKDOWN_BAD_STATE',
  // v0.0.4 W7 遗留 b3 §7.4：用户侧「添加任务」显式带 ref 且会话内已占用（context 带 session_id/ref）。
  'BREAKDOWN_DRAFT_REF_TAKEN',
  // #4 重生成闭环：存在待重新生成的草案时 finish/confirm 被拒（context 带 session_id/refs）。
  'BREAKDOWN_REGENERATION_PENDING',
  // v0.0.4 W8 §8.7 r3：轻确认请求已终结（含 30s+5s 宽限到期），decision 拒收；context.status 带归宿。
  'CREATION_REQUEST_RESOLVED',
  // 8.8 技能源：git/http 远程源本期不实现。
  'NOT_IMPLEMENTED',
  // ── 数据层七枚（2026-09-29「报错全部细化」）：过去全被压成 INTERNAL，
  //    由 `contract/db-errors.ts` 从 Prisma / node:sqlite / fs 的真实形状解出来。
  //    这一组里多数是用户自己能修的（引用没清、开了两个实例、磁盘只读、库损坏、迁移没跑完）。
  'DATA_STILL_REFERENCED',
  'DATA_DUPLICATE',
  'SCHEMA_MISMATCH',
  'STORAGE_UNAVAILABLE',
  'STORAGE_LOCKED',
  'STORAGE_CORRUPT',
  'STORAGE_READONLY',
  // ── 客户端入口八枚（设置 → 客户端入口）：预览/安装/校验/卸载共用。
  'CLIENT_ENTRY_UNSUPPORTED',
  'CLIENT_ENTRY_PATH_UNSAFE',
  'CLIENT_ENTRY_LIMIT_EXCEEDED',
  'CLIENT_ENTRY_CONFLICT',
  'CLIENT_ENTRY_PLAN_STALE',
  'CLIENT_ENTRY_NOT_FOUND',
  'CLIENT_ENTRY_FILE_LOCKED',
  'CLIENT_ENTRY_WRITE_FAILED',
  'INTERNAL',
  // 下面两枚是前端自己的，服务端不会下发：NETWORK_ERROR=没拿到响应，UNKNOWN=认不出的形状。
  'NETWORK_ERROR',
  'UNKNOWN',
] as const;
export type ErrorCode = (typeof ERROR_CODES)[number];

/** 13 章错误体：`{ error: { code, message, ...上下文 } }`，上下文里可能是 task_id / run_id / details。 */
export interface ApiErrorBody {
  error?: {
    code?: string;
    message?: string;
    details?: unknown;
    [context: string]: unknown;
  };
}

/** VALIDATION_FAILED 的 `details[]` 逐字段形态（20.10、13 章）。 */
export interface ValidationIssue {
  path?: string;
  key?: string;
  code?: string;
  message?: string;
}

/* ---------------------------------------------------------------- 任务 DTO */

/** 20.7 卡片 DTO：看板列、列表页行、抽屉概览的公共形状。 */
export interface TaskCard {
  id: string;
  title: string;
  /** 20.3：开放词表，历史值不迁移，词表已删也原样显示。 */
  type: string;
  priority: number;
  tags: string[];
  pinned: boolean;
  status: string;
  status_label: string;
  /** 可为 null：从未上报进度时卡片不渲染进度条（原型 3.3）。 */
  progress: number | null;
  progress_msg: string | null;
  /** #6：最后一次上报进度的时刻（ISO）；历史 Run 未记录该列，可能为 null。 */
  progress_updated_at: string | null;
  lease_expires_at: string | null;
  agent_name: string | null;
  run_count: number;
  due_at: string | null;
  updated_at: string | null;
  blocked: { count: number; by: { id: string; title: string }[] };
  /** 最多 5 条；真实总数看 artifact_count。 */
  artifacts: CardArtifact[];
  artifact_count: number;
  /** 卡片只带 show_on_card 的字段（20.10）。 */
  custom_fields: Record<string, unknown>;
  /** 0919：分组归属（与后端 TaskCardDto.group_id 对齐）。 */
  group_id: string | null;
  /** 0919：子任务的父任务摘要（含父任务下子任务完成度）；无父任务为 null。 */
  parent?: { id: string; title: string; done: number; total: number } | null;
  /** v0.0.4 §8.6（W8-a4）：任务来源（'user' | 'agent'），与 api TaskCardDto 对齐；agent 直建任务挂 5 秒撤销入口。 */
  origin_type: string;
  /**
   * #8：卡片只带「有没有执行规则」的布尔——规则全文最长 20000 字，列表/看板不背全文；
   * 详情另给 `execution_rules` 全文与更新时间。
   */
  has_execution_rules: boolean;
}

export interface CardArtifact {
  id: string;
  type: string;
  /** 20.7：非数据库列，服务端从 metadata.name / uri 末段推导，前端不再解析 URI。 */
  name: string;
}

/** 4.4 概览：`GET /tasks/{id}`，不含 runs / artifacts / 评论（13 章读取模型）。 */
export interface TaskDetail extends TaskCard {
  description: string | null;
  required_capabilities: string[];
  current_run_id: string | null;
  stop_reason: string | null;
  archived_at: string | null;
  created_at: string | null;
  claimed_at: string | null;
  depends_on: DependencyRef[];
  blocks: DependencyRef[];
  /**
   * 1009 拆档后卡片快照不再携带审核方式（看板角标只剩人审一态）；
   * 详情侧仍常返——概览 Tab 的「审核方式」展示与编辑（human/none）读它。
   */
  review_mode: ReviewMode;
  /**
   * 0919 5.2/5.3：子任务全量列表（后端 `familyFields()` 恒回，无子任务为空数组）。
   * 只有「需求」类型会有非空 children。
   */
  children?: TaskChildRef[];
  /** 0919：聚合进度与聚合状态；无子任务为 null（与后端 `TaskDetailDto.aggregate` 同形）。 */
  aggregate?: TaskAggregate | null;
  /** #8：需求级强制规则全文（仅详情返回；卡片只给 `has_execution_rules`）。 */
  execution_rules: string | null;
  /** #8：规则最后一次由用户改动的时间（ISO；从未填过为 null）。 */
  execution_rules_updated_at: string | null;
}

/** 0919：`TaskDetail.children[]` 的元素（后端按 sort_order, created_at 排序）。 */
export interface TaskChildRef {
  id: string;
  title: string;
  type: string;
  status: string;
  priority: number;
  sort_order: number;
}

/** 0919：聚合进度（进度 = done / total）与聚合状态（全 DONE→DONE、全 BACKLOG→BACKLOG、其余 IN_PROGRESS）。 */
export interface TaskAggregate {
  total: number;
  done: number;
  status: 'DONE' | 'BACKLOG' | 'IN_PROGRESS';
}

export interface DependencyRef {
  /** 被依赖/下游任务的 id。 */
  id: string;
  /** 依赖行的 id，DELETE `/dependencies/{dep_id}` 用它。 */
  dep_id: string;
  title: string;
  status: string;
  type: string;
}

/**
 * 列表页行 = 卡片 + 最近一次 Run 的时长与开始时间 + `archived_at`
 * （只有 `GET /tasks` 带这三样，board 的卡片没有）。
 */
export interface TaskListItem extends TaskCard {
  duration_ms: number | null;
  /** 与 `duration_ms` 同一条 Run；RUNNING 时用它算已进行时间。 */
  started_at: string | null;
  archived_at: string | null;
}

export interface Page<T> {
  items: T[];
  total: number;
  page: number;
  page_size: number;
}

/* ------------------------------------------------------------------ 看板 */

export interface BoardColumn {
  status: TaskStatus;
  label: string;
  count: number;
  has_more: boolean;
  tasks: TaskCard[];
}

export interface BoardResponse {
  generated_at: string;
  /** 固定 6 个元素、固定顺序（20.7）。 */
  columns: BoardColumn[];
  /** 与顶栏铃铛同源；WS `notification.created` 会直接带新值。 */
  unread_notifications: number;
}

/* ------------------------------------------------------------ Run / 审核 */

export interface RunArtifact {
  id: string;
  type: string;
  name: string;
  size_bytes: number | null;
  mime_type: string | null;
  created_at: string | null;
  /**
   * 9.3 / 6.10.2 / 验收 42：库里有一行、磁盘上没有文件时为 true。
   * 与后端 `RunArtifactDto.missing`（`apps/api/src/tasks/task.dto.ts`）同名同口径
   * ——`artifact-storage.ts` 的 `isArtifactMissing()`，`link` 不占磁盘所以恒为 false。
   * 产物列表据此**在行上**直接标「已丢失」，不必点开预览框才知道。
   */
  missing: boolean;
}

export interface TaskRun {
  id: string;
  run_number: number;
  status: string;
  trigger_type: string;
  agent_name: string | null;
  started_at: string | null;
  finished_at: string | null;
  duration_ms: number | null;
  progress: number | null;
  progress_msg: string | null;
  summary: string | null;
  error: string | null;
  log_count: number;
  artifacts: RunArtifact[];
  review: Review | null;
}

export interface RunsResult {
  items: TaskRun[];
}

/** 4.6 审核记录：三字段恒非空（4.3）。 */
export interface Review {
  id: string;
  run_id: string | null;
  conclusion: string;
  suggestion: string;
  reason: string;
  detail: string;
  return_to: string | null;
  priority_adj: number | null;
  created_at: string | null;
}

export interface ReviewsResult {
  items: Review[];
}

export interface Comment {
  id: string;
  type: string;
  author_type: string;
  author_name: string | null;
  content: string;
  run_id: string | null;
  created_at: string | null;
}

/** `GET /runs/{id}/logs`：时间正序，界面「加载更早」递增 page。 */
export interface LogLine {
  id: string;
  content: string;
  author_name: string | null;
  created_at: string | null;
}

export interface DependenciesResult {
  depends_on: DependencyRef[];
  blocks: DependencyRef[];
}

/* ------------------------------------------------------------------ 产物 */

export interface ArtifactMeta {
  id: string;
  task_id: string;
  run_id: string | null;
  type: string;
  name: string;
  uri: string;
  size_bytes: number | null;
  mime_type: string | null;
  metadata: Record<string, unknown>;
  created_at: string | null;
  /** 13 章：库里有一行、磁盘无文件时为 true，界面渲染「产物文件已丢失」。 */
  missing?: boolean;
}

/** `POST /artifacts/{id}/sign`：60 秒一次性签名 URL（2218 行：绝不把 Token 放查询参数）。 */
export interface SignedArtifactUrl {
  url: string;
  /** 服务端回的是 `ttl_seconds` + 绝对到期时刻，60 秒一次性（13 章）。 */
  ttl_seconds: number;
  expires_at: string;
}

export interface ArtifactDiff {
  files: {
    path: string;
    additions: number;
    deletions: number;
    hunks: unknown[];
  }[];
}

/* ---------------------------------------------------------------- 通知 */

export interface NotificationItem {
  id: string;
  kind: string;
  task_id: string | null;
  message: string;
  read_at: string | null;
  created_at: string | null;
}

export interface NotificationListResult {
  items: NotificationItem[];
  unread_count: number;
}

/* ---------------------------------------------------------------- 审计 */

export interface AuditEntry {
  id: number;
  actor_type: string;
  actor_name: string | null;
  /**
   * 20.8 的操作人展示口径（`user` → 我、`system` → 系统）由服务端一次定死
   * （`audit-item.dto.ts` 的 `ACTOR_LABEL`，兜 `actor_name` / `actor_type`），两个消费方不再各写一份映射。
   * 服务端每行都带；写成可选是沿用本文件对读路径的兜底口径（旧响应缺键时界面退回本地映射）。
   */
  actor_label?: string | null;
  action: string;
  target_type: string;
  target_id: string | null;
  before: unknown;
  after: unknown;
  created_at: string | null;
}

/* ------------------------------------------------------------ 字段定义 */

export interface FieldDef {
  id: string;
  key: string;
  label: string;
  type: FieldType;
  required: boolean;
  default_value: string | null;
  options: FieldOptions;
  applies_to: string[];
  show_on_card: boolean;
  sort_order: number;
  enabled: boolean;
  created_at: string | null;
  updated_at: string | null;
}

/* ---------------------------------------------------------------- 模板 */

export interface TemplatePreset {
  type?: string;
  priority?: number;
  description?: string;
  tags?: string[];
  required_capabilities?: string[];
  custom_fields?: Record<string, unknown>;
  due_offset_days?: number;
  /**
   * 6.11.1 的「标题前缀」：建任务时拼在标题最前，用户可改。
   * 契约的 `templatePresetSchema` 没有这个键，是 `templates/template.dto.ts` 的
   * `presetSchema` 在本模块补上的（`z.string().trim().max(30).optional()`），两端都吃 ≤ 30 字。
   */
  title_prefix?: string;
}

export interface Template {
  id: string;
  name: string;
  description: string | null;
  preset: TemplatePreset;
  sort_order: number;
  created_at: string;
}

/* --------------------------------------------------------------- Token */

export interface AgentToken {
  id: string;
  name: string;
  capabilities: string[];
  /** 13 章：吊销 = 置 enabled=0，行保留（Run 归属要看得到）。列表含已吊销项。 */
  enabled: boolean;
  prefix?: string;
  last_used_at?: string | null;
  created_at?: string | null;
}

/** `POST /tokens` 响应带一次性明文，服务端只存 hash。 */
export interface IssuedToken extends AgentToken {
  token: string;
}

/* --------------------------------------------------------------- 设置 */

/** #46 贾维斯唤醒词的工作模式：single 一轮即退、continuous 保持到「退出贾维斯」。 */
export const MCP_WAKE_MODES = ['single', 'continuous'] as const;
export type McpWakeMode = (typeof MCP_WAKE_MODES)[number];

export interface Settings {
  lease_ttl_minutes: number;
  heartbeat_interval_seconds: number;
  board_column_limit: number;
  auto_archive_days: number;
  artifact_max_mb: number;
  /** `'off'` 或 `HH:mm`。 */
  backup_time: string;
  backup_keep: number;
  log_retention_days: number;
  log_level: LogLevel;
  task_types: string[];
  ui_theme: 'system' | 'light' | 'dark';
  review_reuse_last_opinion: boolean;
  /** §8.2 创建模式（优先级：参数 confirmation_mode > 此设置 > 默认 light）。 */
  agent_creation_mode: 'direct' | 'light' | 'silent';
  /** §8.8 轻确认卡片超时秒数（20.9 区间 1–300，缺省 30）。 */
  light_confirm_timeout_seconds: number;
  /** #46 唤醒词工作模式，经 initialize 的 instructions 与每次工具响应的模式行下发（hot：改后下一次工具调用即生效）。 */
  mcp_wake_mode: McpWakeMode;
  /**
   * 0020 §3.5（2026-09-28 拍板「三条建单路一处口径」）：REST 建单、Agent 直建、拆解确认页
   * 建子任务共用的默认审核方式。任务级显式 `review_mode` 才覆盖它。
   */
  default_review_mode: ReviewMode;
}
export type SettingsKey = keyof Settings;

export interface BackupFile {
  name: string;
  size_bytes: number;
  created_at: string | null;
}

export interface BackupListResult {
  items: BackupFile[];
  total_size_bytes: number;
  /**
   * 13 章的响应体只有上面两块，`backup.controller.ts` 实际多回一个 `backup_dir`
   * （`BackupService.dir()`，9.3 的存放目录）——原型 7.8 的「备份路径」那一行用的就是它。
   */
  backup_dir: string;
}

/* ------------------------------------------------------- 批量 / 数据接口 */

export interface BatchResult {
  succeeded: string[];
  skipped: { id: string; reason: string }[];
}

export interface ImportPreview {
  tasks: { new: number; updated: number; skipped: number };
  field_defs: { new: number; updated: number; skipped: number };
  conflicts: { kind: string; id: string; detail: string }[];
}

/* ------------------------------------------------------------- 查询与入参 */

export interface BoardQuery {
  view?: BoardView;
  /** B15-①：维内 OR、维间 AND；`none` = 该维未设置。序列化走逗号分隔。 */
  groups?: string[];
  requirements?: string[];
  agents?: string[];
  priority?: number[];
  type?: string[];
  tags?: string[];
  /** 序列化成 `custom_fields[key]=v`（20.7）。 */
  custom_fields?: Record<string, string | string[]>;
}

export interface TaskListQuery {
  status?: TaskStatus[] | string[];
  /** 0919：按分组过滤；`none` = 未分配分组。服务端只收单值，多选由 `useGroupScoped` 拆请求合并。 */
  group_id?: string;
  keyword?: string;
  priority?: number[];
  type?: string[];
  tags?: string[];
  custom_fields?: Record<string, string | string[]>;
  archived?: ArchivedFilter;
  sort?: ListSortField;
  order?: 'asc' | 'desc';
  page?: number;
  page_size?: number;
}

export interface CommentsQuery {
  type?: CommentType[];
  page?: number;
  page_size?: number;
}

export interface AuditQuery {
  target_type?: AuditTargetType | string;
  target_id?: string;
  page?: number;
}

export interface TaskCreateInput {
  title: string;
  type: string;
  /** 0919 五章：创建时归属分组；不传 = 未分配。 */
  group_id?: string | null;
  priority?: number;
  description?: string;
  tags?: string[];
  required_capabilities?: string[];
  custom_fields?: Record<string, unknown>;
  due_at?: string;
  depends_on?: string[];
  dependency_type?: DependencyType;
  pinned?: boolean;
  /**
   * 0919 5.4：挂到需求（父任务）。父必须是「需求」类型且自身不是子任务（嵌套 ≤ 2 层），
   * 违规 → 422 `VALIDATION_FAILED`，`details[].code` 为 `parent_type` / `too_deep`。
   */
  parent_task_id?: string | null;
  /**
   * 创建即绑定技能（10.3，与 PATCH 同一条服务端校验）：只传 `skill_id` 时版本由服务端补
   * 当前有效版本；未知技能/不可解析版本 → 422 `details[].code` = `unknown_skill` / `unknown_version`。
   */
  skills?: { skill_id: string; version?: string }[];
  /**
   * 0020 §3.1/§3.5：任务级审核方式。不传 = 吃设置项 `default_review_mode`（服务端
   * `resolveReviewMode` 是唯一口径来源）；只有人这一侧能写，Agent 建单/改单没有这个入参位。
   */
  review_mode?: ReviewMode;
  /**
   * #8：需求级执行规则（≤20000 字）。仅用户面可写；空串由服务端归一为 null。
   * 规则会在子任务被 Agent 领取时注入并冻结快照，运行中修改只影响下一次领取。
   */
  execution_rules?: string | null;
}

export type TaskPatchInput = Partial<Omit<TaskCreateInput, 'depends_on' | 'dependency_type'>> & {
  description?: string | null;
  due_at?: string | null;
};

export interface TransitionInput {
  to: TaskStatus;
  comment?: string;
}

/** 4.3.1 规则 2：强制停止不要求理由，给了就记进审计。 */
export interface StopInput {
  reason?: string;
}

export interface ReviewInput {
  conclusion: ReviewConclusion;
  /** 4.3：APPROVE 时选填，REJECT 时必填。 */
  suggestion?: string;
  reason?: string;
  detail?: string;
  return_to?: ReturnTarget;
  priority_adj?: number;
  run_id?: string;
}

export interface CommentInput {
  content: string;
  run_id?: string;
}

export interface DependencyCreateInput {
  depends_on: string;
  type?: DependencyType;
}

export interface BatchTransitionInput {
  ids: string[];
  to: TaskStatus;
}

export interface BatchTagsInput {
  ids: string[];
  add?: string[];
  remove?: string[];
}

export interface FieldDefCreateInput {
  key: string;
  label: string;
  type: FieldType;
  required?: boolean;
  default_value?: string | null;
  options?: FieldOptions;
  applies_to?: string[];
  show_on_card?: boolean;
  sort_order?: number;
  enabled?: boolean;
}

/** 13 章：`key` 与 `type` 保存后不可改，PATCH 里出现即 422。 */
export type FieldDefPatchInput = Partial<Omit<FieldDefCreateInput, 'key' | 'type'>>;

export interface TemplateCreateInput {
  name: string;
  description?: string;
  preset: TemplatePreset;
  sort_order?: number;
}
export type TemplatePatchInput = Partial<TemplateCreateInput>;

export interface TokenCreateInput {
  name: string;
  capabilities?: string[];
}

export interface MarkReadInput {
  ids?: string[];
  all?: boolean;
}

export type ExportInput =
  | { scope: 'all'; include_archived: boolean }
  | { scope: 'filtered'; filter: TaskListQuery; include_archived: boolean }
  | { scope: 'selected'; ids: string[]; include_archived: boolean };

export type ImportStrategy = 'skip' | 'overwrite' | 'reassign';

/* ------------------------------------------------------- 需求拆解（v0.0.4 W7 §7） */

/** §7.7 状态机六态；与 apps/api contract/enums.ts 的 BREAKDOWN_SESSION_STATUSES 同值。 */
export const BREAKDOWN_SESSION_STATUSES = [
  'receiving',
  'reviewing',
  'creating',
  'completed',
  'cancelled',
  'interrupted',
] as const;
export type BreakdownSessionStatus = (typeof BREAKDOWN_SESSION_STATUSES)[number];

/** §7.7 状态说明列的中文名（确认页徽标与切换器红点都取这一张表）。 */
export const BREAKDOWN_STATUS_LABEL: Record<BreakdownSessionStatus, string> = {
  receiving: '接收中',
  reviewing: '待确认',
  creating: '创建中',
  completed: '已完成',
  cancelled: '已取消',
  interrupted: '已中断',
};

/** GET /breakdown/sessions 行（服务端 SessionDtoShape 的前端镜像）。 */
export interface BreakdownSession {
  id: string;
  requirement_text: string;
  group_id: string | null;
  parent_title: string;
  parent_description: string | null;
  /** confirm 成功后回填的父任务（需求）id；表外为 null。 */
  parent_task_id: string | null;
  status: BreakdownSessionStatus;
  agent_name: string | null;
  skill_used: string | null;
  estimated_tasks: number | null;
  actual_tasks: number | null;
  /** #4：每次用户侧写/重生成 +1（0=从未），Agent 用 after_revision 续等。 */
  revision: number;
  /** #4：最近一次整份重生成的说明（可空）。 */
  revision_note: string | null;
  /** #4：最近一次整份重生成的请求时刻；无整份重生成时为 null。 */
  revision_requested_at: string | null;
  /** #4：父需求任务被归档的时间（无父任务/未归档为 null），历史列表据此标徽标。 */
  parent_archived_at: string | null;
  created_at: string;
  finished_at: string | null;
  confirmed_at: string | null;
  cancelled_at: string | null;
}

/** GET /breakdown/sessions 的过滤与 keyset 分页参数（#4）。 */
export interface BreakdownListQuery {
  /** active=receiving/reviewing/creating；history=completed/cancelled/interrupted；缺省 all。 */
  scope?: 'active' | 'history' | 'all';
  /** 是否包含父需求已归档的会话（后端默认 false）。 */
  include_archived?: boolean;
  /** 按父需求任务 id 过滤（服务端匹配 parent_task_id）。 */
  requirement_id?: string;
  /** 本页条数（后端默认 100，最大 500）。 */
  limit?: number;
  /** 上一页最后一条会话 id（按 created_at DESC, id DESC 的 keyset 分页）。 */
  cursor?: string;
}

/** 草案任务卡。`skill_ids` 可能残留未解析的技能名（§7.5：不阻断、确认页告警）。 */
export interface BreakdownDraft {
  id: string;
  ref: string;
  title: string;
  description: string | null;
  priority: number;
  skill_ids: string[];
  acceptance: string[];
  /** 会话内稳定引用号（不是任务 id），依赖边以它为坐标。 */
  depends_on: string[];
  sort_order: number;
  /** §7.4「重新生成」：草案已重置、待 Agent 重报（false 时字段省略）。 */
  regeneration_pending?: boolean;
  /** #4：用户本次重生成想改什么（仅 pending 时出现，可空）。 */
  regeneration_note?: string | null;
  /** #4：重生成请求时刻（仅 pending 时出现；旧哨兵行为 null）。 */
  regeneration_requested_at?: string | null;
}

/**
 * 用户侧草案写端点入参（§7.4 / W7 遗留 b3）：PATCH 按下发字段局部更新，
 * skill_ids / depends_on 传了即整体替换；POST 仅 title 有服务端默认。
 */
export interface BreakdownDraftEdit {
  ref?: string;
  title?: string;
  description?: string | null;
  priority?: number;
  skill_ids?: string[];
  acceptance?: string[];
  depends_on?: string[];
  sort_order?: number;
}

/** report_progress 的逐条上报（§7.2 阶段 3 的清单数据源）。 */
export interface BreakdownProgress {
  id: number;
  step: number;
  total: number;
  message: string | null;
  created_at: string;
}

/** GET /breakdown/sessions/{id}：确认页数据源 = 会话 + 草案 + 进度。 */
export interface BreakdownSessionDetail {
  session: BreakdownSession;
  drafts: BreakdownDraft[];
  progress: BreakdownProgress[];
}

/** POST confirm 的返回：父任务 + 子任务 id（阶段 8 的跳转依据）。 */
export interface BreakdownConfirmResult {
  session: BreakdownSession;
  parent_task_id: string;
  task_ids: string[];
}

/* ------------------------------------------------- 会话创建轻确认（§8 / W8） */

/** §8.2 三模式（`tasks.confirmation_mode` 列同词表）。 */
export const CREATION_MODES = ['direct', 'light', 'silent'] as const;
export type CreationMode = (typeof CREATION_MODES)[number];

/** task_creation_logs.user_action 词表：pending + 四种归宿（edited 也回 created 语义的 task_id）。 */
export const CREATION_REQUEST_STATUSES = [
  'pending',
  'created',
  'edited',
  'cancelled',
  'timeout',
] as const;
export type CreationRequestStatus = (typeof CREATION_REQUEST_STATUSES)[number];

/** §8.5 重复检测命中：卡片顶部「疑似重复任务」链接的数据源。 */
export interface CreationDuplicateHit {
  task_id: string;
  title: string;
  /** 0~1 的 Jaccard 相似度（>0.8 才进名单，§8.5）。 */
  similarity: number;
}

/**
 * 轻确认卡片本体：WS `agent.task_requested` 的载荷与 `GET /creation-requests` 的元素同形。
 * 倒计时锚 `expires_at`（§8.4「30 秒超时」）；`decision_deadline_at` = expires_at + 5s 宽限，
 * 之后服务端强制转 timeout 并对 decision 回 409 `CREATION_REQUEST_RESOLVED`（§8.7 r3）。
 */
export interface CreationRequestView {
  request_id: string;
  status: CreationRequestStatus;
  task_id: string | null;
  agent_name: string;
  session_id: string | null;
  source: 'mcp' | 'rest';
  title: string;
  description: string | null;
  group_id: string;
  type: string;
  priority: number;
  tags: string[];
  skills: string[];
  /** #5：归属需求（parent_task_id）；旧请求/未挂需求为 null。 */
  parent_task_id: string | null;
  /**
   * #5 Q4 硬不变量：Agent 只能经 `requested_review_mode` 在 light 模式「请求」审核方式，
   * 永远不能直接写 `review_mode`。两字段并存是因为语义不同——
   * 这里是 Agent 的请求（待决期提示用），`review_mode` 才是服务端拟用/最终值
   * （用户直选 > Agent 请求 > 全局默认）；决策后 `review_mode` 即实际落库值。
   */
  requested_review_mode: ReviewMode | null;
  /** 服务端拟用/最终审核方式：待决期=请求值或全局默认，决策后=实际落库值。 */
  review_mode: ReviewMode;
  duplicates: CreationDuplicateHit[];
  created_at: string;
  expires_at: string;
  decision_deadline_at: string;
}

/**
 * POST /creation-requests/{id}/decision 入参：edit 必带修改后载荷（§8.7 r3，api 侧 zod 同款约束）。
 * `review_mode` 是用户侧唯一能落值的地方（Q4：Agent 只能请求、不能决定）；
 * `parent_task_id` 与后端 decision payload 同形，但本片弹窗不做归属编辑。
 */
export interface CreationDecisionInput {
  action: 'create' | 'edit' | 'cancel';
  payload?: Partial<
    Pick<
      CreationRequestView,
      'title' | 'description' | 'group_id' | 'type' | 'priority' | 'tags' | 'skills' | 'parent_task_id'
    >
  > & { review_mode?: ReviewMode };
}

/* ------------------------------------------------------------- WS 事件载荷 */
export const WS_EVENT_NAMES = [
  'task.created',
  'task.updated',
  'task.moved',
  'task.unblocked',
  'task.deleted',
  'task.archived',
  'run.progress',
  'run.log',
  'lease.expired',
  'notification.created',
  // v0.0.4 W4 §5.6 r3：分组归档/反归档，载荷只带分组 id（事件当失效信号的同一口径）。
  'group.archived',
  'group.unarchived',
  // v0.0.4 W7 §16.3 拆解五条 + #4 重生成通知：服务端只带定位字段（session_id/ref/step…），
  // 读侧回 GET 拿真相。
  'breakdown.started',
  'breakdown.progress',
  'breakdown.task_draft',
  'breakdown.finished',
  // #4：用户请求重生成（单草案 / 整份）时广播，前端只当缓存失效信号。
  'breakdown.revision_requested',
  'breakdown.cancelled',
  // v0.0.4 W8 §8.7 r3：轻确认卡片下发（这条是例外——载荷就是卡片本体，见 features/creation）。
  'agent.task_requested',
] as const;
export type WsEventName = (typeof WS_EVENT_NAMES)[number];

/** 13 章 WS 事件表的逐事件载荷。 */
export interface WsEventPayloads {
  /**
   * `task.created` / `task.updated` 在 13 章写的是「任务对象」，服务端实际只发 `{ id }`：
   * 同一章的读取模型规定事件只当失效信号、不做本地增量，带对象反而诱导这里写增量合并。
   * 例外（W8-a4 §8.6）：`task.created` 额外带 `origin_type`——direct/silent 直建任务前端
   * 只有这一条观察通道，撤销入口按它挂载；仍是定位/归类字段，不是可合并的任务对象。
   */
  'task.created': { id: string; origin_type?: 'user' | 'agent' };
  'task.updated': { id: string };
  'task.moved': { id: string; from: TaskStatus; to: TaskStatus };
  'task.unblocked': { task_id: string };
  'task.deleted': { task_id: string; unblocked_ids: string[] };
  'task.archived': { task_id: string; archived: true };
  'run.progress': { task_id: string; run_id: string; progress: number; message: string | null };
  'run.log': { task_id: string; run_id: string; level: string; message: string };
  'lease.expired': { task_id: string; run_id: string };
  'notification.created': {
    id: string;
    kind: NotificationKind;
    task_id: string | null;
    unread_count: number;
  };
  'group.archived': { id: string };
  'group.unarchived': { id: string };
  // v0.0.4 W7 §16.3：与 apps/api breakdown.service.ts 的 emit 调用逐一对应。
  'breakdown.started': { session_id: string };
  'breakdown.progress': { session_id: string; step: number; total: number };
  'breakdown.task_draft': { session_id: string; ref: string };
  'breakdown.finished': { session_id: string; actual_tasks: number };
  /**
   * #4：载荷与 `apps/api/src/breakdown/breakdown.service.ts` 的两处 emit 一致
   * （单草案 scope=draft + refs=[ref]；整份 scope=session + 全部 refs）。
   * 服务端不在这条事件里带 revision——需要基线时回 GET 详情读 `session.revision`。
   */
  'breakdown.revision_requested': {
    session_id: string;
    scope: 'draft' | 'session';
    refs?: string[];
    note: string | null;
  };
  'breakdown.cancelled': { session_id: string };
  // §8.7 r3：轻确认卡片下发的是请求本体（含倒计时锚点），与 GET 列表同一份视图。
  'agent.task_requested': CreationRequestView;
}

/**
 * 按 `event` 可判别的联合（写成 `interface { event: WsEventName; data: 载荷联合 }` 的话，
 * `switch (frame.event)` 就不会把 `frame.data` 一起收窄，每个消费方都得自己 cast）。
 */
export type WsFrame<K extends WsEventName = WsEventName> = {
  [N in K]: { event: N; data: WsEventPayloads[N]; ts: string };
}[K];

/* ---------------------------------------------------------- 抽屉 Tab 约定 */

/** 13 章读取模型：query key 用 `['task', id, tab]`，Tab 值取这里的字面量。 */
export const TASK_TABS = [
  'overview',
  'runs',
  'reviews',
  'dependencies',
  'comments',
  'audit',
] as const;
export type TaskTab = (typeof TASK_TABS)[number];

/* ------------------------------------------------------ 客户端入口（v0.0.4 W9） */

/**
 * 设置 → 客户端入口：六家客户端的规则/技能安装台账。
 * 词表与 `apps/api/src/contract/client-entry.ts` 同值（服务端值是 snake_case，
 * resource 层 `resources/client-entries.ts` 统一映射成这里的 camelCase，UI 只见这一种风格）。
 */
export const CLIENT_IDS = ['qoder', 'cursor', 'cline', 'windsurf', 'claude_code', 'codex'] as const;
export type ClientId = (typeof CLIENT_IDS)[number];

/**
 * 第七种「伪客户端」custom：其他客户端手动指定目录安装的兜底形态（与 API 契约同值）。
 * 它没有 adapter、没有固定落点（plan/install 必须带 `targetDir`），概览里恒追加一张合成卡；
 * 以后新增客户端不再动 UI——内置端仍用 `CLIENT_IDS`/`ClientId`，台账与请求用 `CLIENT_ENTRY_CLIENTS`。
 */
export const CUSTOM_CLIENT_ID = 'custom';
export const CLIENT_ENTRY_CLIENTS = [...CLIENT_IDS, CUSTOM_CLIENT_ID] as const;
export type ClientEntryClientId = (typeof CLIENT_ENTRY_CLIENTS)[number];

export const CLIENT_ENTRY_SCOPES = ['project', 'user'] as const;
export type ClientEntryScope = (typeof CLIENT_ENTRY_SCOPES)[number];

export const CLIENT_ENTRY_ASSETS = ['rule', 'skill'] as const;
export type ClientEntryAsset = (typeof CLIENT_ENTRY_ASSETS)[number];

export const CLIENT_ENTRY_STATUSES = ['installed', 'drifted', 'missing', 'error'] as const;
export type ClientEntryStatus = (typeof CLIENT_ENTRY_STATUSES)[number];

/** 台账行：一次安装（客户端 × 作用域 × 资产）一条；`custom` 的行也在这个词表里。 */
export interface ClientEntry {
  id: string;
  client: ClientEntryClientId;
  scope: ClientEntryScope;
  /** 项目级才有；用户级为 null（迁移里的 CHECK 同口径）。 */
  workspacePath: string | null;
  assetType: ClientEntryAsset;
  assetName: string;
  targetPath: string;
  writeMode: 'file' | 'managed_block';
  status: ClientEntryStatus;
  /** 安装时的模板版本；低于当前版本时 `updateAvailable` 为 true。 */
  templateVersion: number;
  installedAt: string;
  verifiedAt: string | null;
  lastError: string | null;
  /** 校验时由服务端按模板版本计算（不改状态）。 */
  updateAvailable: boolean;
}

/** 检测结果里的目标候选（路径矩阵的一格；`exists` 只说明文件在不在，不宣称客户端已安装）。 */
export interface ClientTarget {
  scope: ClientEntryScope;
  asset: ClientEntryAsset;
  path: string;
  writeMode: 'file' | 'managed_block';
  confidence: 'confirmed' | 'probable';
  exists: boolean;
  note?: string;
}

/**
 * 检测结果卡：内置六端各一张，`custom` 合成卡恒在末尾（targets 空、detected 两项 false、
 * entries 为全部 custom 台账行，不按 workspace 过滤）。
 */
export interface ClientDetectResult {
  client: ClientEntryClientId;
  label: string;
  /** 该客户端支持的资产类型（Cline / Windsurf 不含 skill）。 */
  assets: ClientEntryAsset[];
  scopes: ClientEntryScope[];
  stability: Record<ClientEntryAsset, 'stable' | 'experimental'>;
  notes: string[];
  detected: { project: boolean; user: boolean };
  targets: ClientTarget[];
  entries: ClientEntry[];
  /** 各作用域的生效提示（new session / reload window …）。 */
  effectHint: Record<ClientEntryScope, string>;
}

export interface ClientEntryPlanAction {
  assetType: ClientEntryAsset;
  assetName: string;
  targetPath: string;
  writeMode: 'file' | 'managed_block';
  action: 'create' | 'update' | 'unchanged' | 'conflict';
  reason?: string;
  content: string;
  contentChars: number;
  contentHash: string;
  expectedPrevHash: string | null;
  backupRequired: boolean;
  warnings: string[];
  /** Windsurf 全局规则等客户端自带的字符上限；超出时安装必须显式豁免。 */
  charLimit?: number;
  /**
   * 写入后整份文件的字符数（服务端计算）：托管块模式含块外用户原有内容，
   * 独立文件模式即整份文件；与 `contentChars`（本应用内容长度）不是一个口径。
   * 超限判定只看这个值；旧响应缺该键时前端不自行推算。
   */
  limitChars?: number;
}

export interface ClientEntryPlan {
  client: ClientEntryClientId;
  scope: ClientEntryScope;
  planHash: string;
  actions: ClientEntryPlanAction[];
  warnings: string[];
}

/** 自测到达记录（MCP `wake_probe` 落行；只证明工具链路，不证明规则一定生效）。 */
export interface WakeProbe {
  id: string;
  source: string | null;
  tokenName: string | null;
  receivedAt: string;
}

export interface ClientEntryOverview {
  clients: ClientDetectResult[];
  selfTest: {
    serverName: string;
    mcpEndpoint: string;
    wakeMode: 'single' | 'continuous';
    recent: WakeProbe[];
  };
}

export interface ClientEntryInstallResult {
  entries: ClientEntry[];
  actions: ClientEntryPlanAction[];
}

export interface ClientEntryVerifyResult {
  entries: ClientEntry[];
  summary: Record<ClientEntryStatus, number>;
}

export interface ClientEntryUninstallResult {
  removed: boolean;
  /**
   * 卸载结局的补充说明：
   * - `drifted`：用户改过文件（托管块内正文哈希与安装时不一致）→ `removed=false`，保留并标记漂移；
   * - `missing`：文件已不在 → `removed=false`，保留台账；
   * - `unmanaged`：安装前已存在、内容相同被接管的文件（`created_file=0`）→ 保留原文件、
   *   只删台账（`removed=true`）：本应用从未拥有这份文件。
   */
  kept?: 'drifted' | 'missing' | 'unmanaged';
  entry?: ClientEntry;
}

/**
 * 计划入参；请求体由 resource 层转成后端 snake_case（`assets` 显式空数组与缺省语义不同）。
 * `targetDir` 只属于 `custom` 伪客户端（必填，用户选的绝对路径）；内置六端必须不传，
 * 传了服务端按字段错误拒绝（path=`target_dir` 的 422）。
 */
export interface ClientEntryPlanInput {
  client: ClientEntryClientId;
  scope: ClientEntryScope;
  /** 项目级必填；用户级不传（服务端只写白名单根）。custom 走 `targetDir`，不带它。 */
  workspace?: string;
  /** custom 的安装根目录（绝对路径，允许目录尚不存在）；内置六端不传。 */
  targetDir?: string;
  /** 不传 = 由服务端按客户端能力取默认资产。 */
  assets?: ClientEntryAsset[];
}

/** 安装入参：`planHash` 来自预览，服务端重新计划后比对，不一致 → 409 `CLIENT_ENTRY_PLAN_STALE`。 */
export interface ClientEntryInstallInput extends ClientEntryPlanInput {
  planHash: string;
  confirm: true;
  /** Windsurf 全局规则超字符上限时的显式豁免（默认阻止）。 */
  allowOverLimit?: boolean;
}

/** `GET /client-entries/self-test` 的响应；概览里的同一份数据叫 `recent`。 */
export interface ClientEntrySelfTest {
  serverName: string;
  mcpEndpoint: string;
  wakeMode: 'single' | 'continuous';
  probes: WakeProbe[];
}
