/** PRD 二十章数据契约总表的代码化单一来源。接口、DDL、前端展示名都从这里取。 */

export const TASK_STATUS = [
  'BACKLOG',
  'READY',
  'RUNNING',
  'REVIEW',
  'DONE',
  'FAILED',
] as const;
export type TaskStatus = (typeof TASK_STATUS)[number];

export const STATUS_LABEL: Record<TaskStatus, string> = {
  BACKLOG: '需求池',
  READY: '待执行',
  RUNNING: '执行中',
  REVIEW: '待审核',
  DONE: '已完成',
  FAILED: '异常/失败',
};

/** 4.1：看板固定六列、固定顺序。 */
export const BOARD_COLUMNS: TaskStatus[] = [...TASK_STATUS];

export const PRIORITY_LABEL = ['紧急', '高', '中', '低'] as const;
export const PRIORITIES = [0, 1, 2, 3] as const;

export const STOP_REASONS = ['user_stop', 'lease_expired', 'agent_reported'] as const;
export type StopReason = (typeof STOP_REASONS)[number];

export const RUN_STATUS = ['RUNNING', 'SUCCESS', 'FAILED', 'ABANDONED'] as const;
export type RunStatus = (typeof RUN_STATUS)[number];

export const TRIGGER_TYPES = ['agent_poll', 'manual_retry', 'auto_retry'] as const;
export type TriggerType = (typeof TRIGGER_TYPES)[number];

export const REVIEW_CONCLUSIONS = ['APPROVE', 'REJECT'] as const;
export type ReviewConclusion = (typeof REVIEW_CONCLUSIONS)[number];

export const RETURN_TARGETS = ['BACKLOG', 'READY'] as const;

export const DEP_TYPES = ['blocks', 'relates'] as const;
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
  'settings_change',
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

export const DEFAULT_TASK_TYPES = ['需求', '缺陷', '子任务', '巡检', '重构'] as const;

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

/** 读取到表外值时的展示兜底（20.2 末段）：不崩溃、原样透传、渲染「未知（原值）」。 */
export function enumLabel<T extends string>(
  map: Partial<Record<T, string>>,
  value: T | string,
): string {
  return map[value as T] ?? `未知（${value}）`;
}
