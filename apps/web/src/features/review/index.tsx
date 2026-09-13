/**
 * 审核相关 UI 的宿主（PRD 6.5 审核、6.6 审核反馈给 Agent、8.4 审核页；原型 5 章）。
 *
 * 两个导出对应两个容器，保持基座既有的导出名不动（`src/app/app.tsx` 与
 * `src/app/overlay-slot.tsx` 已分别挂好它们）：
 * - `ReviewPage`：`#/review` 导航页（待审核表格 + 历史审核）。
 * - `ReviewFormDialog`：720px 审核表单，由 overlay-slot 按 `useShellStore().reviewTaskId`
 *   挂载，三个入口共用（看板拖到「审核」、抽屉「审核 →」、本页行内「审核」）。
 */
export { ReviewPage } from './review-page';
export { ReviewFormDialog, type ReviewFormDialogProps } from './review-form';
