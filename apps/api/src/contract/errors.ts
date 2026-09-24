export const ERROR_STATUS = {
  UNAUTHORIZED: 401,
  INVALID_BACKUP_NAME: 400,
  FORBIDDEN: 403,
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
  // v0.0.4 W2（§9.2 r2）：重名不再受限（唯一性收敛到 id）；SKILL_NAME_TAKEN 随 0010 迁移移除。
  // 同 ID 导入冲突（§9.8.4）：409 回给 UI「覆盖更新/跳过」选项。
  SKILL_ID_CONFLICT: 409,
  // 默认技能只读（§9.1）：拒改拒删拒发版本。
  SKILL_READONLY: 403,
  // v0.0.4 #19③（W2/W3 遗留）：技能子引用 skillRef 的自引用（入参本身非法，400）
  // 与引用成环（与库内既有图冲突，409）。原就近定义在 skills/skill-reference.ts，已归位。
  SKILL_REF_SELF: 400,
  SKILL_REF_CYCLE: 409,
  // v0.0.4 W1b §5.5：活跃分组达到上限 50 后拒绝新建。
  GROUP_LIMIT_REACHED: 409,
  // v0.0.4 W1-D1 §5.2/§5.5：预置「默认」分组不可删除；§5.6 口径下同样不可归档。
  GROUP_DEFAULT_PROTECTED: 409,
  // v0.0.4 W4 §5.6：组内还有未完成/未归档任务时拒绝归档（上下文带 remaining 剩余数）。
  GROUP_NOT_ALL_DONE: 409,
  // v0.0.4 W4 §5.6：归档分组转为只读——不能再向该组建任务/移动任务进来。
  GROUP_ARCHIVED: 409,
  // v0.0.4 W7 §7.7：拆解会话状态机守卫——动作要求的当前状态不满足
  // （如非 receiving 时上报草案、非 reviewing 时确认创建）。上下文带 session_id/status/allowed。
  BREAKDOWN_BAD_STATE: 409,
  // v0.0.4 W7 遗留 b3 §7.4：用户侧「添加任务」显式带 ref 且会话内已占用（UNIQUE(session_id, ref)）。
  // 上下文带 session_id/ref。不传 ref 由服务端自动取号，不会走到这个码。
  BREAKDOWN_DRAFT_REF_TAKEN: 409,
  // v0.0.4 W8-a2 §8.7：轻确认决策回传时请求已终结（已建/已取消/已超时/宽限期外）。
  CREATION_REQUEST_RESOLVED: 409,
  // v0.0.4 §16.1 `update_task`（MCP 全字段 PATCH）：任务停在 BLOCKED/REVIEW/DONE/FAILED
  // 这些「编辑窗口之外」的状态。与 TASK_RUNNING（执行中、可持租约改）分开：本码必须
  // 在 details 里指名该走哪条链路（审核/重开/转 READY 重新认领），让 Agent 一次改对。
  TASK_NOT_EDITABLE: 409,
  ARTIFACT_TOO_LARGE: 413,
  LEASE_EXPIRED: 410,
  LEASE_REVOKED: 410,
  VALIDATION_FAILED: 422,
  INVALID_PARAM: 422,
  // 8.8 技能源：git/http 远程源本期不实现
  NOT_IMPLEMENTED: 501,
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
