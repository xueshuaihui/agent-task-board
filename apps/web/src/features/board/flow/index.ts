/**
 * v0.0.4 W5 流程图第三视图（§6.4）对外出口：
 * - `FlowBoardView` 由看板页在 `mode==='flow'` 时挂载；
 * - `useViewPrefsStore` 同时服务「设置 / 视图」Tab 与流程图工具栏（同一份偏好，即时生效）。
 */
export { FlowBoardView } from './FlowBoardView';
export {
  DEFAULT_VIEW_PREFS,
  useViewPrefsStore,
  type BoardDisplayMode,
  type FlowDirection,
  type ViewPrefs,
} from './view-prefs';
