/**
 * v0.0.4 W8 §8.7「Agent 建任务轻确认决策卡片 + §8.6 直建 5 秒撤销」前端片。
 *
 * - `CreationRequestHost`：右下角全局浮层宿主（挂 `app/overlay-slot.tsx`，一份栈服务全应用）。
 * - `useCreationStore`：卡片栈（WS 载荷直存，终态就地收口）。
 * - `useCreationRequests`：断线重连补未决卡片的数据源（`GET /creation-requests`）。
 *
 * §8.6 撤销覆盖度：本片的 5 秒撤销入口挂在**轻确认卡片刚创建出的任务**上（decision 回包带 task_id，
 * 前端自己记 5 秒起点）。`direct`/`silent` 两模式直建的任务前端**观察不到**——
 * api 读路径（`/tasks`、`/board`、`task.created` 载荷 `{id}`）都不带 `origin_type`，
 * 而 §13 读取模型禁止事件做本地增量，所以不硬造轮询。这两模式的撤销入口等 api 暴露 origin
 * 字段（#26 的 DELETE 守卫同片）后接，见 v0.0.4 W8-web 交接清单。
 */
export { CreationRequestHost } from './creation-host';
export { CreationCard } from './creation-card';
export { CreationEditDialog } from './creation-edit-dialog';
export { useCreationRequests } from './queries';
export { useCreationStore, isTerminalStatus, type CreationCard as CreationCardState } from './store';
