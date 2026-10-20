/**
 * 流程图运行态动效的纯判定（Issue #7「流程图看不出哪些任务在运行」）。
 *
 * 动效本体全部在 globals.css（节点呼吸光晕 / 流动虚线描边、边流动虚线），
 * 这里只收口「谁该动」的布尔逻辑，方便在没有 jsdom 的 web 测试里直接单测：
 * - 节点只认精确的 `RUNNING`；
 * - 连线只给 blocks 边且任一端 RUNNING 时加动画，relates 保持静态；
 * - 同屏 RUNNING 节点数超过阈值时关闭连线动画（节点呼吸保留），防止大图卡顿。
 */

/** 同屏 RUNNING 节点数超过该值时关闭连线动画（`>` 20 即 21 起关闭）。 */
export const RUNNING_EDGE_ANIMATION_LIMIT = 20;

/** 运行态判定：只认精确的 RUNNING，未知/空状态一律按非运行处理。 */
export function isRunningStatus(status: string | null | undefined): boolean {
  return status === 'RUNNING';
}

/** 同屏 RUNNING 数量是否允许连线动画（阈值内允许）。 */
export function edgeAnimationEnabled(runningCount: number): boolean {
  return runningCount <= RUNNING_EDGE_ANIMATION_LIMIT;
}

export type EdgeMotionDependencyType = 'blocks' | 'relates';

export interface EdgeMotionInput {
  depType: EdgeMotionDependencyType | undefined;
  /** 边的 source 或 target 处于 RUNNING（FlowBoardView 组装边时注入）。 */
  running: boolean;
  /** 阈值判定结果（FlowBoardView 计算，超过阈值传 false）。 */
  animate: boolean;
}

/**
 * 边是否显示流动虚线：blocks 边 + 相邻 RUNNING + 阈值内，三者同时成立。
 * relates 是关联关系、不构成执行方向，永远保持静态，避免满屏噪声。
 */
export function shouldAnimateEdge({ depType, running, animate }: EdgeMotionInput): boolean {
  return depType === 'blocks' && running && animate;
}
