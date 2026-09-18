/**
 * 依赖图 DAG 分层布局（纯函数，2.md 8.1–8.3）。
 *
 * 输入任务集合 + 依赖边（from = 前置任务，to = 依赖它的任务），输出每个节点的
 * 行列坐标：按拓扑层级分行（前置在上），同层从左到右排开、整体水平居中。
 *
 * 环兜底（PRD 6.2：添加依赖时后端已检测，这里只防历史脏数据把布局算挂）：
 * 先用 Kahn 算法剥掉所有能进队列的节点完成分层；剥不掉的节点视为处在环上，
 * 统一放到最后一层并标记 `inCycle`，两端都在环上的边标记 `cycle`，渲染为
 * 红色虚线（DependencyGraphCanvas），不参与任何一层的高度计算。
 *
 * 节点卡片 180×72（2.md 8.3），边距与层距给足贝塞尔曲线的弯曲空间。
 */

export const NODE_WIDTH = 180;
export const NODE_HEIGHT = 72;
/** 同层节点水平间距 / 层与层的垂直间距（层距里含 NODE_HEIGHT）。 */
export const NODE_GAP_X = 56;
export const LAYER_GAP_Y = 64;
/** 画布内边距，防止第一层贴边。 */
export const LAYOUT_PADDING = 32;

/** 布局输入的最小任务形状：TaskCard / TaskListItem / TaskDetail 都能直接喂进来。 */
export interface GraphTask {
  id: string;
  title: string;
  status: string;
  priority: number;
  /** 从未上报时为 null，节点不画进度条（同卡片 DTO 约定）。 */
  progress: number | null;
  /** 可选：需求内依赖图（2.md 8.2）按它过滤；全局图不传。 */
  requirement_id?: string | null;
}

export type GraphDependencyType = 'blocks' | 'relates';

/** from → to：from 是前置（depends_on 方向），箭头指向被阻塞的 to。 */
export interface GraphEdgeInput {
  /** 依赖行 id，DELETE /tasks/{id}/dependencies/{dep_id} 用。 */
  depId: string;
  from: string;
  to: string;
  type: GraphDependencyType;
}

export interface LayoutNode extends GraphTask {
  x: number;
  y: number;
  layer: number;
  /** 节点处在依赖环上、无法分层时的兜底标记。 */
  inCycle: boolean;
}

export interface LayoutEdge extends GraphEdgeInput {
  /** 环边：不计入分层，渲染为虚线。 */
  cycle: boolean;
}

export interface GraphLayout {
  nodes: LayoutNode[];
  edges: LayoutEdge[];
  /** 内容总尺寸（含内边距），供「适应屏幕」计算缩放。 */
  width: number;
  height: number;
}

export interface LayoutOptions {
  nodeWidth?: number;
  nodeHeight?: number;
  gapX?: number;
  gapY?: number;
  padding?: number;
}

export function computeDependencyLayout(
  tasks: readonly GraphTask[],
  edges: readonly GraphEdgeInput[],
  options: LayoutOptions = {},
): GraphLayout {
  const nodeW = options.nodeWidth ?? NODE_WIDTH;
  const nodeH = options.nodeHeight ?? NODE_HEIGHT;
  const gapX = options.gapX ?? NODE_GAP_X;
  const gapY = options.gapY ?? LAYER_GAP_Y;
  const padding = options.padding ?? LAYOUT_PADDING;

  const known = new Set(tasks.map((task) => task.id));
  // 端点不在任务集合里的边（跨需求引用等）不参与布局，避免幽灵节点。
  const visibleEdges = edges.filter((edge) => known.has(edge.from) && known.has(edge.to));

  const { layers, inCycle } = assignLayers(tasks, visibleEdges);

  const nodes: LayoutNode[] = [];
  const maxRowWidth = Math.max(
    0,
    ...layers.map((layer) => layer.length * nodeW + (layer.length - 1) * gapX),
  );

  layers.forEach((layer, layerIndex) => {
    const rowWidth = layer.length * nodeW + (layer.length - 1) * gapX;
    const startX = padding + (maxRowWidth - rowWidth) / 2;
    layer.forEach((task, columnIndex) => {
      nodes.push({
        ...task,
        x: startX + columnIndex * (nodeW + gapX),
        y: padding + layerIndex * (nodeH + gapY),
        layer: layerIndex,
        inCycle: inCycle.has(task.id),
      });
    });
  });

  const width = padding * 2 + maxRowWidth;
  const height = padding * 2 + Math.max(0, layers.length - 1) * (nodeH + gapY) + nodeH;

  return {
    nodes,
    edges: visibleEdges.map((edge) => ({ ...edge, cycle: inCycle.has(edge.from) && inCycle.has(edge.to) })),
    width,
    height,
  };
}

/**
 * Kahn 分层：layer(n) = 1 + max(layer(前置))。返回每层的任务列表与剥不掉的
 * 环上节点集合。同层顺序沿用输入顺序（任务列表本身已按优先级/时间排好）。
 */
function assignLayers(
  tasks: readonly GraphTask[],
  edges: readonly GraphEdgeInput[],
): { layers: GraphTask[][]; inCycle: Set<string> } {
  // 前置 → 依赖它的任务；入度 = 未处理的前置边数。
  const dependents = new Map<string, string[]>();
  const indegree = new Map<string, number>();
  for (const task of tasks) {
    dependents.set(task.id, []);
    indegree.set(task.id, 0);
  }
  for (const edge of edges) {
    // 重复依赖行只算一次入度，否则 Kahn 会多剥。
    const list = dependents.get(edge.from);
    if (list && !list.includes(edge.to)) {
      list.push(edge.to);
      indegree.set(edge.to, (indegree.get(edge.to) ?? 0) + 1);
    }
  }

  const layerOf = new Map<string, number>();
  let queue = tasks.filter((task) => (indegree.get(task.id) ?? 0) === 0).map((task) => task.id);
  let processed = 0;

  while (queue.length > 0) {
    const next: string[] = [];
    for (const id of queue) {
      const own = layerOf.get(id) ?? 0;
      layerOf.set(id, own);
      processed += 1;
      for (const childId of dependents.get(id) ?? []) {
        // longest-path：层 = 所有前置层里的最大值 + 1。
        layerOf.set(childId, Math.max(layerOf.get(childId) ?? 0, own + 1));
        const remaining = (indegree.get(childId) ?? 0) - 1;
        indegree.set(childId, remaining);
        if (remaining === 0) next.push(childId);
      }
    }
    queue = next;
  }

  const inCycle = new Set<string>();
  if (processed < tasks.length) {
    for (const task of tasks) {
      if (!layerOf.has(task.id)) inCycle.add(task.id);
    }
  }

  const maxLayer = layerOf.size
    ? Math.max(...layerOf.values())
    : -1;
  const layerCount = maxLayer + 1 + (inCycle.size > 0 ? 1 : 0);
  const layers: GraphTask[][] = Array.from({ length: layerCount }, () => []);
  for (const task of tasks) {
    const layer = layerOf.get(task.id);
    if (layer === undefined) {
      // 环上节点兜底：挤到 DAG 之后的独立一层，虚线红边标示。
      layers[layerCount - 1].push(task);
    } else {
      layers[layer].push(task);
    }
  }
  return { layers: layers.filter((layer) => layer.length > 0), inCycle };
}
