/**
 * features/breakdown：v0.0.4 W7 需求拆解会话 UI（PRD §7.3 拆解创建页）。
 *
 * 与 features/requirements 的关系：那边是「需求（任务树）」的存量视图，
 * 这里是「拆解会话」的覆盖层 + 需求下的二级页面（#4.3 方案 B，
 * `#/requirements/breakdown`）。两者只在 confirm 成功后交汇
 * （跳转并打开新建需求的抽屉）。数据只走 §16.2 的四个 REST 端点 +
 * §16.3 六条 breakdown.* WS 失效信号（含 #4 `breakdown.revision_requested`）。
 *
 * W7 遗留 b1 补齐（v0.0.4）：§7.3 待确认页流程图（draft-graph）、
 * §7.4 草案最小编辑（draft-edit/draft-editor；b3 起为乐观层，落库走服务端写端点）、
 * §7.8 确认后 5 秒撤销窗口（breakdown-overlay 内的倒计时条）。
 * #4：单条/整份「重新生成」带说明、待重报时禁用确认并复制唤起指令；
 * 历史会话在二级页面用 cursor 分页只读查看。
 */
export { BreakdownOverlayHost } from './breakdown-host';
export { BreakdownOverlay, BreakdownWorkspace } from './breakdown-overlay';
export { BreakdownPage } from './breakdown-page';
export { useBreakdownOverlayStore } from './store';
export { BreakdownStatusBadge } from './session-switcher';
export {
  useBreakdownSessions,
  useBreakdownHistory,
  useBreakdownSession,
  useBreakdownConfirm,
  useBreakdownCancel,
  useBreakdownDraftWrite,
  useBreakdownRegenerateDraft,
  useBreakdownRegenerateSession,
} from './queries';
export { DraftFlowGraph } from './draft-graph';
export { DraftEditor } from './draft-editor';
export {
  skillCandidateLabel,
  skillStatusOf,
  type AnnotatedDraft,
  type BreakdownDetailAnnotated,
  type DraftSkillState,
  type DraftSkillStatus,
  type SkillResolutionReport,
} from './skill-status';
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
