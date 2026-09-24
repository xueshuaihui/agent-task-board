import type { TaskStatus } from '@/api/types';

/**
 * §5.2 方案 A：看板卡跨列飞行的触发/抑制控制（渲染期纯判定，无订阅、无状态提升）。
 *
 * 数据流前提（mutations.ts 顶部注释）：本项目**没有本地乐观更新**，一切换列都来自
 * `/board` 快照的异步重取（用户动作 → invalidate → refetch，或 WS 信号 → 同样失效重取）。
 * 因此「旧列 exit 能否被预先抑止」只有唯一可靠窗口：在用户动作发起、数据还没变的
 * 那段 pending 期内，旧列每次渲染都把该卡渲染成「不带 exit、带 layoutId」的飞行源；
 * 快照到达的同一提交里旧节点瞬时卸载 + 新节点带同一 layoutId 挂载 → 共享元素飞行。
 * WS 驱动的换列没有这个先手窗口（旧列最后一次渲染已把 140ms exit 定死，若再挂
 * layoutId 会造成旧列淡出残影与飞行双动画并存——正是 §5.2 禁止的鬼影），
 * 按回落规则天然退化为方案 B（旧列 exit 140ms + 新列单项淡入，即现有 itemVariants 路径）。
 *
 * 六条回落规则的落点：
 * - 规则 6（WS/重取驱动的换列）：即上方「无先手窗口」段——实现上等价于「不登记标记」，
 *   与 motion-spec §5.2 触发面注记同口径；
 * - 规则 1（目标列未渲染）：G-5（2026-09-24 用户拍板）起七列在任何视图下恒常驻等分
 *   （列不随筛选结果折叠，原 `columnCollapsed` 已删），换列后目标列必然在树里，这一条
 *   只剩「容器横向溢出、目标列被滚出可视区」一种未渲染到位情形（仍在 DOM 内，投影按
 *   其布局位置计算）；泳道视图整体不参与飞行（折叠泳道 display 即卸载，全部走方案 B）；
 * - 规则 2（跨滚动容器）：`layoutScroll` 挂在横向滚动行与列内纵向滚动容器上尽力修正，
 *   真机走查不达 §5.2 验收门槛时用本文件 `FLY_ENABLED` 一键退回方案 B；
 * - 规则 3（reduced-motion）：`flyRole` 的 `reduced` 入参，命中即 null（且列组件现有
 *   reduce 分支已把 initial/animate/exit 全部置瞬时）；
 * - 规则 4（一次重算换列 ≥4 张）：`BoardPage` 对快照做 card→status 差分，命中阈值就把
 *   本轮移动卡全部写进抑制名单（见 `suppressFly` 的调用点）；
 * - 规则 5（当前/刚释放的拖拽源）：dnd `onDragEnd` 写抑制名单（dropAnimation 160ms +
 *   50ms 余量），`markPendingMove` 在抑制期内直接跳过，拖拽换位一律以落位动画为唯一语言。
 */

/**
 * 全局开关（R2 走查兜底）：若真机发现飞行鬼影/坐标错乱，翻成 false 即全板瞬时退回
 * 方案 B（旧列 exit 140ms + 新列单项淡入 200ms），无需回滚其余代码。
 */
export const FLY_ENABLED = true;

/** pending 标记寿命：覆盖「用户动作 → 服务端快照回传」的往返；超时自动按方案 B 演化。 */
const MARK_TTL_MS = 1_500;

/** 规则 5：dropAnimation 160ms + 50ms 余量。此窗口内该卡不参与飞行。 */
export const FLY_DROP_SUPPRESS_MS = 210;

/** 规则 4：一轮数据重算中换列卡数达到该阈值（批量流转/导入/WS 重连全量刷）即全部抑制。 */
export const FLY_BATCH_LIMIT = 4;
/** 批量抑制窗口：盖过本轮提交里目标节点的挂载与后续短重渲。 */
export const FLY_BATCH_SUPPRESS_MS = 600;

/** 卡在本轮渲染中的飞行角色（同一提交内新旧列读到的判定必须一致）。 */
export type FlyRole = 'source' | 'target';

interface MoveMark {
  /** 发起动作时卡片所在列（状态）。 */
  readonly from: string;
  /** 用户请求的目标状态。 */
  readonly to: TaskStatus;
  readonly until: number;
}

const moveMarks = new Map<string, MoveMark>();
const suppressFlyUntil = new Map<string, number>();

/** layoutId 命名空间前缀：只在看板六列树内共享，避免与浮层/抽屉里将来可能出现的同名 id 相撞。 */
export function boardCardLayoutId(taskId: string): string {
  return `board-card-${taskId}`;
}

function isSuppressed(taskId: string, now: number): boolean {
  const until = suppressFlyUntil.get(taskId);
  if (until === undefined) return false;
  if (now >= until) {
    suppressFlyUntil.delete(taskId);
    return false;
  }
  return true;
}

/**
 * 在 mutation 发起的同帧记录「这张卡即将换列」。
 * 只由用户主动动作调用（`actions.move` 的 ✅ 分支）；WS 重取没有任何标记，
 * 那部分换列按回落规则走方案 B。拖拽源在抑制期内（规则 5）静默跳过。
 */
export function markPendingMove(taskId: string, from: string, to: TaskStatus): void {
  if (!FLY_ENABLED || from === to) return;
  const now = Date.now();
  sweepExpired(now);
  if (isSuppressed(taskId, now)) return;
  moveMarks.set(taskId, { from, to, until: now + MARK_TTL_MS });
}

/**
 * 全量清过期条目：两张表只被「还在盘面上的卡」惰性读取（isSuppressed/flyRole），
 * 被删除/归档的卡留下的条目永远等不到那次惰性清理，在用户动作入口顺手全量扫一次。
 */
function sweepExpired(now: number): void {
  for (const [id, mark] of moveMarks) if (now >= mark.until) moveMarks.delete(id);
  for (const [id, until] of suppressFlyUntil) if (now >= until) suppressFlyUntil.delete(id);
}

/** 写入/延长抑制窗口（规则 4、5 共用）。后写覆盖更晚的过期时间。 */
export function suppressFly(taskId: string, ttlMs: number): void {
  const until = Date.now() + ttlMs;
  const prev = suppressFlyUntil.get(taskId);
  if (prev === undefined || prev < until) suppressFlyUntil.set(taskId, until);
}

/**
 * 渲染期判定该卡（状态为 `status` 的那一列里）的飞行角色：
 * - `'source'`：卡片仍停在来源列且有生效标记 → 挂 layoutId 并**撤掉 exit**，
 *   让快照到达时与目标列挂载同帧瞬时卸载，由飞行接管（方案 A 本体，§5.2）；
 * - `'target'`：卡片已出现在目标列 → 挂 layoutId、跳过 itemVariants 入场
 *   （位置由飞行承担，不重复播淡入 + y8）；
 * - `null`：无标记 / 已过期 / 被抑制 / reduced-motion / `FLY_ENABLED` 关闭 →
 *   完全等同现状渲染（方案 B 形态）。
 * 标记随过期、状态确认离开来源列而清除——服务端确认后绝不重放动画（§5.1）。
 */
export function flyRole(taskId: string, status: string, reduced = false): FlyRole | null {
  if (!FLY_ENABLED || reduced) return null;
  const now = Date.now();
  if (isSuppressed(taskId, now)) {
    moveMarks.delete(taskId);
    return null;
  }
  const mark = moveMarks.get(taskId);
  if (!mark) return null;
  if (now >= mark.until) {
    moveMarks.delete(taskId);
    return null;
  }
  if (status === mark.to && mark.to !== mark.from) return 'target';
  if (status === mark.from) return 'source';
  // 快照里卡片落在了别处（服务端走了不同目标/多跳）：飞行目标不确定，按方案 B 演化。
  moveMarks.delete(taskId);
  return null;
}
