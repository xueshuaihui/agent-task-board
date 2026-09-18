export const ERROR_STATUS = {
  UNAUTHORIZED: 401,
  INVALID_BACKUP_NAME: 400,
  FORBIDDEN: 403,
  // 0919：mustChangePassword=true 时除改密/me/logout 外的 UI 接口一律拒绝
  MUST_CHANGE_PASSWORD: 403,
  NOT_FOUND: 404,
  ARTIFACT_LOST: 404,
  BACKUP_NOT_FOUND: 404,
  ILLEGAL_TRANSITION: 409,
  TASK_NOT_RUNNING: 409,
  TASK_RUNNING: 409,
  TASK_GONE: 409,
  ARCHIVE_BLOCKED_BY_DEPENDENCY: 409,
  DEPENDENCY_CYCLE: 409,
  IMPORT_ID_CONFLICT: 409,
  FIELD_IN_USE: 409,
  // 0919：技能管理（8 章）
  SKILL_BOUND: 409,
  SKILL_NAME_TAKEN: 409,
  ARTIFACT_TOO_LARGE: 413,
  LEASE_EXPIRED: 410,
  LEASE_REVOKED: 410,
  VALIDATION_FAILED: 422,
  INVALID_PARAM: 422,
  INTERNAL: 500,
} as const satisfies Record<string, number>;

export type ErrorCode = keyof typeof ERROR_STATUS;

/** 13 章统一错误响应体：{ error: { code, message, ...上下文 } } */
export class ApiException extends Error {
  constructor(
    readonly code: ErrorCode,
    message: string,
    readonly details?: unknown,
    readonly context: Record<string, unknown> = {},
  ) {
    super(message);
  }

  get status(): number {
    return ERROR_STATUS[this.code];
  }

  toBody() {
    return {
      error: {
        code: this.code,
        message: this.message,
        ...this.context,
        ...(this.details === undefined ? {} : { details: this.details }),
      },
    };
  }
}

/** 4.5 统一提示文案：前端按此实现，不自行措辞。服务端在同一处给出，避免文案分叉。 */
export const USER_COPY = {
  dragToRunning: '执行中由 Agent 认领产生，请使用卡片上的"强制停止"',
  dragOutOfRunning: '执行中由 Agent 认领产生，请使用卡片上的"强制停止"',
  dragOutOfDone: '已完成是终态。需要重做请新建任务并设为其后续',
  archiveBlocked: (n: number) =>
    `该任务仍是 ${n} 个未完成任务的前置，无法归档。请先处理下游`,
  deleteConfirm: (n: number, m: number) =>
    `将同时删除 ${n} 条执行记录及其产物。${m > 0 ? `下游 ${m} 个任务将立即变为可执行。` : ''}`,
  stopConfirm: 'Agent 可能仍在继续执行，平台不再接受它的结果。',
  leaseExpired: '租约已过期，结果未写入',
  leaseRevoked: '租约已被强制停止吊销，结果未写入',
  dependencyCycle: (chain: string) => `依赖关系形成环：${chain}，已取消保存`,
  restoreConfirm:
    '当前全部任务、执行记录、审核记录与审计日志将被覆盖，不可撤销；产物文件不在备份范围内，恢复后缺失的产物显示『产物文件已丢失』；当前执行中的任务会全部转为异常/失败。',
  emptyBackup:
    '还没有备份。导出 JSON 不等于备份——它不含产物文件与审计记录，Run 只保留状态与时长。',
} as const;
