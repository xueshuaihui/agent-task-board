/**
 * v0.0.4 W8 §8.7「Agent 建任务轻确认决策卡片 + §8.6 直建 5 秒撤销」前端片。
 *
 * - `CreationRequestHost`：右下角全局浮层宿主（挂 `app/overlay-slot.tsx`，一份栈服务全应用）。
 * - `useCreationStore`：卡片栈（WS 载荷直存，终态就地收口）。
 * - `useCreationRequests`：断线重连补未决卡片的数据源（`GET /creation-requests`）。
 *
 * §8.6 撤销覆盖度：本片的 5 秒撤销入口覆盖两条直建路径——
 * 1. 轻确认卡片刚创建出的任务（decision 回包带 task_id，前端自己记 5 秒起点）；
 * 2. `direct`/`silent` 直建（W8-a4 接通）：api 读路径与 `task.created` 载荷已带
 *    `origin_type`，`agent-undo-stack.tsx` 观察 WS 事件里 agent 来源的新任务，
 *    同一右下角栈挂「撤销 5s」入口，点击走存量 `DELETE /tasks/{id}`。
 */
export { CreationRequestHost } from './creation-host';
export { CreationCard } from './creation-card';
export { CreationEditDialog } from './creation-edit-dialog';
export { useCreationRequests } from './queries';
export { useCreationStore, isTerminalStatus, type CreationCard as CreationCardState } from './store';
