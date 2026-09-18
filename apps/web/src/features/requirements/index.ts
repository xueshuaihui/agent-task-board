/**
 * features/requirements：0919「需求与子任务」的需求侧能力（2.md 第四/六/八章）。
 *
 * 对外导出分三类：
 * - 组件挂载：`RequirementDrawerHost` / `DependencyGraphGlobalHost` —— 壳层各挂一次；
 * - 命令式入口：`openRequirement`（store）与 `openDependencyGraph` —— 任意 onClick 可调；
 * - 数据件：`RequirementBadge` —— 看板/列表卡片按 `card.parent` 条件渲染。
 */
export { RequirementDrawer, RequirementDrawerHost } from './requirement-drawer';
export { useRequirementDrawerStore } from './requirement-store';
export { RequirementBadge, type RequirementBadgeProps } from './requirement-badge';
export {
  DependencyGraphGlobalHost,
  openDependencyGraph,
  closeDependencyGraph,
} from './dependency-graph-modal';
