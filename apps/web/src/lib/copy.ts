/**
 * 4.5 / 4.3.1 / 9.3 的统一提示文案。
 * 这份是 apps/api/src/contract/errors.ts `USER_COPY` 的前端镜像：服务端在同一处给文案，
 * 错误响应里的 `message` 优先用它；这里补的是「弹窗确认语」这类没有响应可搭车的文案，
 * 目的是让界面与 sidecar 不再各写一套措辞。改一边要同步另一边。
 */
export const COPY = {
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
  artifactLost: '产物文件已丢失（不在备份范围内）',
  wsReconnecting: '实时连接已断开，正在重连…',
  wsGone: '实时连接已断开',
  sidecarDown: '本地服务无响应，可能正在重启（托盘菜单可重启服务）',
} as const;
