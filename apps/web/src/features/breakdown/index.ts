/**
 * features/breakdown：v0.0.4 W7 需求拆解会话 UI（PRD §7.3 拆解创建页）。
 *
 * 与 features/requirements 的关系：那边是「需求（任务树）」的存量视图，
 * 这里是「拆解会话」的新覆盖层，两者只在 confirm 成功后交汇
 * （跳转并打开新建需求的抽屉）。数据只走 §16.2 的四个 REST 端点 +
 * §16.3 五条 breakdown.* WS 失效信号。
 *
 * W7 遗留 b1 补齐（v0.0.4）：§7.3 待确认页流程图（draft-graph）、
 * §7.4 草案最小编辑（draft-edit/draft-editor；b3 起为乐观层，落库走服务端写端点）、
 * §7.8 确认后 5 秒撤销窗口（breakdown-overlay 内的倒计时条）。
 */
export { BreakdownOverlayHost } from './breakdown-host';
export { BreakdownOverlay } from './breakdown-overlay';
export { useBreakdownOverlayStore } from './store';
export { BreakdownStatusBadge } from './session-switcher';
export {
  useBreakdownSessions,
  useBreakdownSession,
  useBreakdownConfirm,
  useBreakdownCancel,
  useBreakdownDraftWrite,
} from './queries';
export { DraftFlowGraph } from './draft-graph';
export { DraftEditor } from './draft-editor';
export {
  addDraft,
  dependsReachable,
  hasDependencyCycle,
  makeDraft,
  nextDraftRef,
  patchDraft,
  removeDraft,
  toggleDependency,
} from './draft-edit';
