/**
 * features/breakdown：v0.0.4 W7 需求拆解会话 UI（PRD §7.3 拆解创建页）。
 *
 * 与 features/requirements 的关系：那边是「需求（任务树）」的存量视图，
 * 这里是「拆解会话」的新覆盖层，两者只在 confirm 成功后交汇
 * （跳转并打开新建需求的抽屉）。数据只走 §16.2 的四个 REST 端点 +
 * §16.3 五条 breakdown.* WS 失效信号，编辑能力（§7.4）未在本片落地。
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
} from './queries';
