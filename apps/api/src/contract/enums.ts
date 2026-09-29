/** PRD 二十章数据契约总表的代码化单一来源。接口、DDL、前端展示名都从这里取。 */

export const TASK_STATUS = [
  'BACKLOG',
  'READY',
  'RUNNING',
  // 8.4 人工块：Agent 执行到人工块时任务转人工阻塞，人工处理后回 READY 重新认领。
  'BLOCKED',
  'REVIEW',
  'DONE',
  'FAILED',
] as const;
export type TaskStatus = (typeof TASK_STATUS)[number];

export const STATUS_LABEL: Record<TaskStatus, string> = {
  BACKLOG: '需求池',
  READY: '待执行',
  RUNNING: '执行中',
  BLOCKED: '人工阻塞',
  REVIEW: '待审核',
  DONE: '已完成',
  FAILED: '异常/失败',
};

/** 4.1：看板列 = 状态全集、固定顺序（§6.1 加 BLOCKED 后为 7 列）。 */
export const BOARD_COLUMNS: TaskStatus[] = [...TASK_STATUS];

export const PRIORITY_LABEL = ['紧急', '高', '中', '低'] as const;
export const PRIORITIES = [0, 1, 2, 3] as const;

/**
 * v0.0.4 W1-D1（需求.md §5.2 / §21.1 / §19）：预置「默认」分组的固定主键与名称。
 * 0009 迁移以同值植入行（撞名存量则就地转正既有「默认」行、保留其 id）；
 * 新建任务未指定分组、存量无归属任务都归到这里；不可删除、不可归档（§5.5/§5.6）。
 */
export const DEFAULT_GROUP_ID = 'grp_default';
export const DEFAULT_GROUP_NAME = '默认';

export const STOP_REASONS = ['user_stop', 'lease_expired', 'agent_reported'] as const;
export type StopReason = (typeof STOP_REASONS)[number];

export const RUN_STATUS = ['RUNNING', 'SUCCESS', 'FAILED', 'ABANDONED'] as const;
export type RunStatus = (typeof RUN_STATUS)[number];

export const TRIGGER_TYPES = ['agent_poll', 'manual_retry', 'auto_retry'] as const;
export type TriggerType = (typeof TRIGGER_TYPES)[number];

export const REVIEW_CONCLUSIONS = ['APPROVE', 'REJECT'] as const;
export type ReviewConclusion = (typeof REVIEW_CONCLUSIONS)[number];

/**
 * 任务审核方式（草案 §3.1，迁移 0020 的 tasks.review_mode CHECK 同值）：
 * human=人工审核（默认，Q1「默认强制人工审核、任务级显式豁免」）/ auto=审核后入待自动审核队列 /
 * none=免审核直通。写面只有 REST create/PATCH 与全局默认键——update_task 的可写键清单恒不含它
 * （Q4 硬不变量：执行者不得自豁免）。
 */
export const REVIEW_MODES = ['human', 'auto', 'none'] as const;
export type ReviewMode = (typeof REVIEW_MODES)[number];

/**
 * REVIEW 列内的换轨位（草案 §3.4，迁移 0020 的 tasks.review_track CHECK 同值）：
 * auto=等审核器（claim_next_review 可领）/ human=人工待审（人优先，审核器不领）。
 * 只在 REVIEW 状态有意义，其余状态是遗留值、读面恒返回；换轨触发点（ESCALATE/转人工）在 A2。
 */
export const REVIEW_TRACKS = ['auto', 'human'] as const;
export type ReviewTrack = (typeof REVIEW_TRACKS)[number];

/** reviews 行的结论来源（草案 §3.2，迁移 0020 的 reviews.reviewer_type CHECK 同值；存量行回填 user）。 */
export const REVIEWER_TYPES = ['user', 'agent'] as const;
export type ReviewerType = (typeof REVIEWER_TYPES)[number];

export const RETURN_TARGETS = ['BACKLOG', 'READY'] as const;

/**
 * 依赖边的种类（词表权威在迁移的列级 CHECK：0001 建表钉 blocks/relates，**0021 扩出 review**）。
 * `review` 是审核批次任务的**纯标记边**（自动审核器草案 §3.2）：方向固定 `批次 → 被审对象`
 * （task_id=批次、depends_on=对象），N 条边即「审 N 支」；它**不参与认领过滤、不参与环检测**
 * （与 relates 同级的处置）。反查「这支被哪支活跃批次覆盖」= `depends_on=? AND type='review'`。
 */
export const DEP_TYPES = ['blocks', 'relates', 'review'] as const;
export type DependencyType = (typeof DEP_TYPES)[number];

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
  // v0.0.4 W8-a3 §13.9（r3）：会话创建通知规则键（light 待决请求 / silent·direct 创建成功）；
  // 落库词表权威在迁移 0014 的 notifications.kind CHECK。
  'creation_request',
  // 自动审核链路两枚（草案 §3.4/§3.6，词表权威在迁移 0020 的 notifications.kind CHECK）：
  // review_auto_pending = complete 分流进 REVIEW/track=auto（等待审核器认领）；
  // review_auto_passed  = 审核器判通过、任务转 DONE 时通知——触发点在第二片 A2，
  // 契约定稿与 CHECK 扩容在本片一次做完，A2 不再动 kind 枚举。
  'review_auto_pending',
  'review_auto_passed',
] as const;
export type NotificationKind = (typeof NOTIFICATION_KINDS)[number];

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
  // §21.2-3 的 `migration.completed`（数据目录一次性搬迁；本表动作名统一 snake_case）。
  'migration_completed',
  'settings_change',
  'group_change',
  // v0.0.4 W4 §5.6 r3：归档/反归档的专门审计动作（原文 group.archive / group.unarchive，
  // 本表动作名统一 snake_case）。
  'group_archive',
  'group_unarchive',
  'pref_change',
  // v0.0.4 W6 §12.6：MCP 治理审计两条——调用前的策略决策记录（check_mcp_policy）
  // 与调用后的结果上报（report_mcp_call），本地信任模型下的尽力记录。
  'mcp_policy_check',
  'mcp_call',
  // v0.0.4 W7 §7.2 阶段 7：拆解会话的两个用户动作（确认创建 / 取消）。
  'breakdown_confirm',
  'breakdown_cancel',
  // W7 遗留 b2 §7.7/20.3-10：定时收敛与 confirm 兜底把超期会话标 interrupted 的系统动作。
  'breakdown_timeout',
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
  'group',
  'preference',
  // v0.0.4 W6 §12.6：MCP 策略决策与调用结果的审计对象类型。
  'mcp',
  // v0.0.4 W7 §7.6：拆解会话（confirm/cancel 的审计目标）。
  'breakdown_session',
] as const;
export type AuditTargetType = (typeof AUDIT_TARGET_TYPES)[number];

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

export const FIELD_TYPE_LABEL: Record<FieldType, string> = {
  text: '文本',
  textarea: '多行文本',
  number: '数字',
  select: '单选',
  multiselect: '多选',
  date: '日期',
  bool: '布尔',
  url: '链接',
};

/** 20.5：本期约定的能力命名空间，未约定的按字符串全等匹配、不校验取值。 */
export const CAPABILITY_NAMESPACES = ['language', 'framework', 'repo', 'tool'] as const;

// ---------------------------------------------------------------- v0.0.4 W7 需求拆解（§7.6/§7.7）

/** §7.7 拆解会话状态机全集；与迁移 0012 的 breakdown_sessions.status CHECK 同值。 */
export const BREAKDOWN_SESSION_STATUSES = [
  'receiving',
  'reviewing',
  'creating',
  'completed',
  'cancelled',
  'interrupted',
] as const;
export type BreakdownSessionStatus = (typeof BREAKDOWN_SESSION_STATUSES)[number];

export const BREAKDOWN_STATUS_LABEL: Record<BreakdownSessionStatus, string> = {
  receiving: '接收中',
  reviewing: '待确认',
  creating: '创建中',
  completed: '已完成',
  cancelled: '已取消',
  interrupted: '已中断',
};

/**
 * 任务类型缺省词表（设置项 task_types 的默认值，20 章全量表）。
 * 自动审核器草案 §3.1 追加第六词 `审核`，但它**是服务端保留类型**：
 * - 只有服务端建批路径造得出的批次任务（`tasks.review_batch=1`）用它；
 * - 四个建单面（REST 人建 / 看板快捷新建 / 拆解确认 / MCP `board.create_task` 与
 *   `create_tasks_batch`）一律拒绝用户手建该类型 → `422 TASK_TYPE_RESERVED`（N21），
 *   `get_vocabulary` 的 `task_types` 对 Agent 面也不含它——**这两道闸与词表过滤在 A4 片落地**，
 *   本片只落词表默认值（§7 第 4 条）；
 * - **行为判据是 `tasks.review_batch`，不是这个字符串**：用户可在设置里改名或删除该词，
 *   回路不得因此被打断（§3.1）。
 */
export const DEFAULT_TASK_TYPES = ['需求', '缺陷', '子任务', '巡检', '重构', '审核'] as const;

/**
 * v0.0.4 W8 §8.2 会话创建确认模式三值（词表唯一来源）：
 * direct=直接创建并记账 / light=轻确认（缺省，等用户在确认页决策）/ silent=静默创建并记账。
 * `board.create_task` 的 confirmation_mode 入参与 settings.agent_creation_mode 都从这里收，
 * 迁移 0013 的 tasks.confirmation_mode CHECK 与之同值。
 */
export const AGENT_CONFIRMATION_MODES = ['direct', 'light', 'silent'] as const;
export type AgentConfirmationMode = (typeof AGENT_CONFIRMATION_MODES)[number];

/** 20.7：board 的 view 预设，取值见 6.2 第 5 条。 */
export const BOARD_VIEWS = ['all', 'review', 'failed', 'claimable', 'blocked'] as const;
export type BoardView = (typeof BOARD_VIEWS)[number];

export const ARCHIVED_FILTERS = ['false', 'true', 'all'] as const;

export const LIST_SORT_FIELDS = ['id', 'priority', 'status', 'created_at', 'updated_at'] as const;
export type ListSortField = (typeof LIST_SORT_FIELDS)[number];

export const CLAIM_REASONS = ['no_ready_task', 'all_blocked'] as const;
export type ClaimReason = (typeof CLAIM_REASONS)[number];

/** 20.3 标签约束。 */
export const TAG_MAX_LENGTH = 16;
export const TAGS_MAX_PER_TASK = 10;

/** 20.8 单 Run 日志上限：超出保留首 1000 行 + 最近 4000 行。 */
export const LOG_LINES_MAX = 5000;
export const LOG_LINES_HEAD = 1000;
export const LOG_LINES_TAIL = 4000;

/**
 * 20.2 末段：值是否落在枚举表内。读路径用它决定要不要记 error 日志——
 * 表外值（历史库、手改数据）不崩溃、原样透传，界面渲染「未知（原值）」。
 */
export function isKnownEnum<T extends string>(allowed: readonly T[], value: unknown): value is T {
  return typeof value === 'string' && (allowed as readonly string[]).includes(value);
}

/**
 * 表外枚举值的上报口（20.2 末段）。DTO 侧只做纯判定与透传，怎么记（error 日志、去重）
 * 由 service 注入，这样 DTO 保持无副作用、可在单测里直接换 spy。
 */
export type UnknownEnumReport = (table: string, field: string, value: string) => void;
