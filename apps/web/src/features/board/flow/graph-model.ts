import type { GraphEdgeInput } from '@/features/dependency-graph/layout';

/**
 * 流程图视图的纯图算法（v0.0.4 W5 §6.4.5–6.4.7）：
 * 全部只对 `blocks` 边计算（§6.4.4 里 `relates` 是虚线关联、不构成顺序约束），
 * 环上的节点（历史脏数据，后端建环已被拦）通过拓扑排序自然被排除，不做高亮。
 */

export interface DirectedGraph {
  /** 节点 id 全集。 */
  ids: readonly string[];
  /** blocks 有向边：from 是前置，to 被阻塞。 */
  edges: readonly GraphEdgeInput[];
}

/** 邻接表：from → to[]（下游方向）。 */
export function buildAdjacency(ids: readonly string[], edges: readonly GraphEdgeInput[]): Map<string, string[]> {
  const idSet = new Set(ids);
  const adjacency = new Map<string, string[]>();
  for (const id of ids) adjacency.set(id, []);
  for (const edge of edges) {
    if (edge.type !== 'blocks') continue;
    if (!idSet.has(edge.from) || !idSet.has(edge.to)) continue;
    adjacency.get(edge.from)!.push(edge.to);
  }
  return adjacency;
}

/** BFS 闭包：从 seeds 出发沿 direction 方向可达的节点集（含 seeds 自身）。 */
export function reachable(
  seeds: Iterable<string>,
  adjacency: Map<string, string[]>,
): Set<string> {
  const seen = new Set<string>();
  const queue = [...seeds];
  for (const seed of queue) seen.add(seed);
  while (queue.length > 0) {
    const current = queue.shift()!;
    for (const next of adjacency.get(current) ?? []) {
      if (seen.has(next)) continue;
      seen.add(next);
      queue.push(next);
    }
  }
  return seen;
}

/** 反向邻接（上游方向）：to → from[]，只含 blocks 边。 */
export function buildUpstream(
  ids: readonly string[],
  edges: readonly GraphEdgeInput[],
): Map<string, string[]> {
  const idSet = new Set(ids);
  const upstream = new Map<string, string[]>();
  for (const id of ids) upstream.set(id, []);
  for (const edge of edges) {
    if (edge.type !== 'blocks') continue;
    if (!idSet.has(edge.from) || !idSet.has(edge.to)) continue;
    upstream.get(edge.to)!.push(edge.from);
  }
  return upstream;
}

/**
 * §6.4.5 关键路径：blocks 子图上「所有起点到终点的最长（按节点数）路径」。
 * Kahn 拓扑序上做最长路 DP，再自最远终点回溯前驱。环上节点不进拓扑序，
 * 因而不会参与路径；DAG 退化成孤立点时返回空集（没有路径可言）。
 */
export function criticalPath(
  ids: readonly string[],
  edges: readonly GraphEdgeInput[],
): { nodes: Set<string>; edges: Set<string> } {
  const idSet = new Set(ids);
  const blocksEdges = edges.filter(
    (edge) => edge.type === 'blocks' && idSet.has(edge.from) && idSet.has(edge.to),
  );
  const downstream = buildAdjacency(ids, blocksEdges);
  const upstream = buildUpstream(ids, blocksEdges);

  const indegree = new Map<string, number>();
  for (const id of ids) indegree.set(id, 0);
  for (const edge of blocksEdges) {
    if (edge.from === edge.to) continue;
    indegree.set(edge.to, (indegree.get(edge.to) ?? 0) + 1);
  }
  let queue = ids.filter((id) => (indegree.get(id) ?? 0) === 0);
  const order: string[] = [];
  while (queue.length > 0) {
    const next: string[] = [];
    for (const id of queue) {
      order.push(id);
      for (const child of downstream.get(id) ?? []) {
        const remaining = (indegree.get(child) ?? 0) - 1;
        indegree.set(child, remaining);
        if (remaining === 0) next.push(child);
      }
    }
    queue = next;
  }

  // dp[id] = 以 id 结尾的最长路径的节点数；pred[id] = 取到该最长值时的前驱。
  const dp = new Map<string, number>();
  const pred = new Map<string, string>();
  for (const id of order) {
    let best = 0;
    let bestFrom: string | null = null;
    for (const parent of upstream.get(id) ?? []) {
      const value = dp.get(parent) ?? 0;
      if (value > best) {
        best = value;
        bestFrom = parent;
      }
    }
    dp.set(id, best + 1);
    if (bestFrom) pred.set(id, bestFrom);
  }

  // 终点（出度 0 且在拓扑序里）中挑最长；同长取先出现的，保证结果稳定。
  let tail: string | null = null;
  let tailLength = 0;
  for (const id of order) {
    if ((downstream.get(id) ?? []).length > 0) continue;
    const length = dp.get(id) ?? 0;
    if (length > tailLength) {
      tail = id;
      tailLength = length;
    }
  }
  const nodes = new Set<string>();
  const pathEdges = new Set<string>();
  if (!tail || tailLength < 2) return { nodes: nodes, edges: pathEdges };
  let cursor: string | null = tail;
  while (cursor) {
    nodes.add(cursor);
    const parent: string | null | undefined = pred.get(cursor);
    if (parent) {
      const edge = blocksEdges.find((item) => item.from === parent && item.to === cursor);
      if (edge) pathEdges.add(edge.depId);
    }
    cursor = parent ?? null;
  }
  return { nodes, edges: pathEdges };
}

/**
 * §6.4.6 阻塞链：被阻塞的任务（BLOCKED 状态或卡片带未满足前置）及其全部上游，
 * 红色高亮。`blockedOf` 由视图层给（数据来自 TaskCard.blocked.count 与 status）。
 */
export function blockingChain(
  ids: readonly string[],
  edges: readonly GraphEdgeInput[],
  blockedOf: (id: string) => boolean,
): { nodes: Set<string>; edges: Set<string> } {
  const seeds = ids.filter(blockedOf);
  const upstream = buildUpstream(ids, edges);
  const nodes = reachable(seeds, upstream);
  const idSet = new Set(ids);
  const pathEdges = new Set<string>();
  for (const edge of edges) {
    if (edge.type !== 'blocks') continue;
    if (!idSet.has(edge.from) || !idSet.has(edge.to)) continue;
    if (nodes.has(edge.from) && nodes.has(edge.to)) pathEdges.add(edge.depId);
  }
  return { nodes, edges: pathEdges };
}

/** §6.4.7 聚焦范围 → 可见节点集（含锚点自身）。 */
export function focusSet(
  anchor: string,
  scope: 'up' | 'down' | 'all',
  ids: readonly string[],
  edges: readonly GraphEdgeInput[],
): Set<string> {
  const downstream = buildAdjacency(ids, edges);
  const upstream = buildUpstream(ids, edges);
  const result = new Set<string>([anchor]);
  if (scope === 'down' || scope === 'all') reachable([anchor], downstream).forEach((id) => result.add(id));
  if (scope === 'up' || scope === 'all') reachable([anchor], upstream).forEach((id) => result.add(id));
  return result;
}
