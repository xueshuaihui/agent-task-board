import type {
  ArtifactType,
  AuditAction,
  AuthorType,
  CommentType,
  DependencyType,
  FieldType,
  McpWakeMode,
  NotificationKind,
  ReviewConclusion,
  RunStatus,
  StopReason,
  TaskStatus,
  TriggerType,
} from '@/api/types';

/**
 * 20.2 枚举总表的中文展示名。取值集合与 apps/api/src/contract/enums.ts 一一对应，
 * 那边改枚举要同步这里（前端不能 import 后端包，两处各自有测试/评审兜住）。
 */

export const STATUS_LABEL: Record<TaskStatus, string> = {
  BACKLOG: '需求池',
  READY: '待执行',
  RUNNING: '执行中',
  BLOCKED: '人工阻塞',
  REVIEW: '待审核',
  DONE: '已完成',
  FAILED: '异常/失败',
};

/** 20.2：数值越小越优先。 */
export const PRIORITY_LABEL: Record<0 | 1 | 2 | 3, string> = {
  0: '紧急',
  1: '高',
  2: '中',
  3: '低',
};

export const RUN_STATUS_LABEL: Record<RunStatus, string> = {
  RUNNING: '执行中',
  SUCCESS: '执行成功',
  FAILED: '执行失败',
  ABANDONED: '已放弃',
};

export const TRIGGER_TYPE_LABEL: Record<TriggerType, string> = {
  agent_poll: 'Agent 轮询',
  manual_retry: '手动重试',
  auto_retry: '自动重试',
};

export const STOP_REASON_LABEL: Record<StopReason, string> = {
  user_stop: '用户强制停止',
  lease_expired: '租约超时回收',
  agent_reported: 'Agent 自报失败',
};

export const REVIEW_CONCLUSION_LABEL: Record<ReviewConclusion, string> = {
  APPROVE: '通过',
  REJECT: '驳回',
};

export const DEPENDENCY_TYPE_LABEL: Record<DependencyType, string> = {
  blocks: '阻塞',
  relates: '关联',
};

export const COMMENT_TYPE_LABEL: Record<CommentType, string> = {
  comment: '评论',
  log: '执行日志',
  status_change: '状态变更',
};

export const AUTHOR_TYPE_LABEL: Record<AuthorType, string> = {
  user: '我',
  agent: 'Agent',
  system: '系统',
};

export const ARTIFACT_TYPE_LABEL: Record<ArtifactType, string> = {
  diff: '代码变更',
  image: '图片',
  text: '文本',
  log: '日志',
  markdown: 'Markdown',
  json: 'JSON',
  html: 'HTML',
  pdf: 'PDF',
  link: '外链',
  file: '文件',
};

export const NOTIFICATION_KIND_LABEL: Record<NotificationKind, string> = {
  review_pending: '进入待审核',
  run_failed: '执行失败',
  lease_expired: '租约过期',
  review_rejected: '审核被驳回',
  task_unblocked: '依赖已解锁',
};

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

/**
 * 17.2：阶段一只渲染 5 类控件；`multiselect`/`date`/`url` 的控件与筛选分组属阶段二。
 * 类型仍要能读出来（历史值不迁移），渲染时按 PHASE_ONE_FIELD_TYPES 决定是否给控件。
 */
export const PHASE_ONE_FIELD_TYPES: readonly FieldType[] = [
  'text',
  'textarea',
  'number',
  'select',
  'bool',
];

/** 6.9.1：`show_on_card` 只开放四类（textarea 在 248px 卡片上必然截断成噪声）。 */
export const CARD_FIELD_TYPES: readonly FieldType[] = ['text', 'number', 'select', 'bool'];

export const AUDIT_ACTION_LABEL: Record<AuditAction, string> = {
  task_create: '创建任务',
  task_update: '编辑任务',
  task_transition: '状态流转',
  task_stop: '强制停止',
  task_delete: '删除任务',
  task_archive: '归档/恢复',
  archive_skipped: '归档被跳过',
  run_claim: 'Agent 认领',
  run_writeback: '结果回写',
  lease_expire: '租约过期',
  review_submit: '提交审核',
  dep_add: '添加依赖',
  dep_remove: '移除依赖',
  field_def_change: '字段定义变更',
  template_change: '模板变更',
  token_issue: '生成 Token',
  token_revoke: '吊销 Token',
  token_use: 'Token 调用',
  import: '导入',
  export: '导出',
  backup: '备份',
  restore: '恢复',
  migration_completed: '数据迁移完成',
  settings_change: '设置变更',
  group_change: '分组变更',
  group_archive: '分组归档',
  group_unarchive: '分组取消归档',
  pref_change: '偏好变更',
  mcp_policy_check: 'MCP 策略裁决',
  mcp_call: 'MCP 调用上报',
  breakdown_confirm: '确认拆解',
  breakdown_cancel: '取消拆解',
  breakdown_timeout: '拆解超期中断',
};

/**
 * #46 贾维斯唤醒词的工作模式（20.9 `mcp_wake_mode`）：短标签在此，长说明属设置页文案。
 * 取值集合与 apps/api/src/contract/settings.ts 的枚举一一对应。
 */
export const MCP_WAKE_MODE_LABEL: Record<McpWakeMode, string> = {
  single: '单次对话',
  continuous: '连续对话',
};

/**
 * 20.2 末段：读到表外值（历史库、手改数据）时不崩溃、原样透传，界面渲染「未知（原值）」。
 * 与后端 `enumLabel()` 同一语义。
 */
export function labelOf<T extends string>(map: Partial<Record<T, string>>, value: string): string {
  return map[value as T] ?? `未知（${value}）`;
}

export function statusLabel(status: string): string {
  return labelOf<TaskStatus>(STATUS_LABEL, status);
}

export function priorityLabel(priority: number): string {
  const key = priority as 0 | 1 | 2 | 3;
  return PRIORITY_LABEL[key] ?? `未知（P${priority}）`;
}

/** 列表页与卡片都显示 `P0..P3` 前缀（原型 3.8）。 */
export function priorityText(priority: number): string {
  return `P${priority} ${priorityLabel(priority)}`;
}

/**
 * 版本串统一加 `v` 前缀。服务端市场返回的已经是 `v1.0.0`、本地技能库的是 `1.0.0`，
 * 模板里写死 `v{version}` 会把前者显示成 `vv1.0.0`。
 */
export function versionLabel(version: string): string {
  if (!version) return '';
  return version.startsWith('v') ? version : `v${version}`;
}
