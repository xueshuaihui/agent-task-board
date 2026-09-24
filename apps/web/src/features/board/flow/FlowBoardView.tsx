import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Background,
  BackgroundVariant,
  MiniMap,
  Panel,
  ReactFlow,
  ReactFlowProvider,
  Controls,
  SelectionMode,
  useEdgesState,
  useNodesState,
  useReactFlow,
  type Connection,
  type Edge,
  type Node,
  type OnBeforeDelete,
} from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import { Loader2, Locate, Move, SquareDashed } from 'lucide-react';
import type { TaskCard } from '@/api/types';
import { STATUS_LABEL } from '@/lib/labels';
import { cn } from '@/lib/cn';
import { useShellStore } from '@/app/store/shell';
import { useActiveGroups } from '@/features/groups/queries';
import { computeDependencyLayout, type GraphEdgeInput } from '@/features/dependency-graph/layout';
import { useAddDependency, useRemoveDependency } from '@/features/dependency-graph/useDependencyGraph';
import type { BoardMutations } from '@/features/board/mutations';
import { DependencyEdge } from './DependencyEdge';
import { FLOW_NODE_HEIGHT, FLOW_NODE_SIMPLE_HEIGHT, TaskFlowNode, statusColor, type TaskFlowNodeData } from './TaskFlowNode';
import { blockingChain, criticalPath, focusSet } from './graph-model';
import { getFlowLayout, hydrateFlowLayout, useViewPrefsStore, writeFlowLayout, type FlowLayout } from './view-prefs';

/**
 * 流程图第三视图（v0.0.4 W5 §6.4.1：把依赖图升级为看板的第三种视图）。
 *
 * 数据源 = 看板当前可见任务（六列快照拉平，归档分组默认不在其中——§5.6
 * 「流程图默认隐藏」由服务端 buildFilters 同款口径继承）+ 逐任务依赖边
 * （`useDependencyEdges`，与依赖 Tab / 旧依赖图弹窗共享缓存）。
 *
 * 画布能力全部来自 @xyflow/react（§6.4.10「不自研画布基础能力」）：
 * MiniMap / Controls / Background(网点) / Panel / 框选多选 / 节点边
 * selectable-draggable-deletable / fitView+zoomToExtent / snapToGrid /
 * 边 label / 自定义 Handle / 键盘操作 / 拖拽连线建依赖。
 * 本文件只做任务语义粘合：状态着色、关键路径、阻塞链、聚焦、详情抽屉、右键菜单。
 */

const NODE_TYPES = { task: TaskFlowNode };
const EDGE_TYPES = { dep: DependencyEdge };

export interface FlowBoardViewProps {
  tasks: readonly TaskCard[];
  edges: readonly GraphEdgeInput[];
  edgesLoading: boolean;
  mutations: BoardMutations;
  /** 复用看板页的删除确认对话框（DeleteDialog + remove mutation）。 */
  onRequestDelete: (card: TaskCard) => void;
}

export function FlowBoardView(props: FlowBoardViewProps) {
  return (
    <ReactFlowProvider>
      <FlowCanvas {...props} />
    </ReactFlowProvider>
  );
}

type FlowNode = Node<TaskFlowNodeData>;
type FlowEdge = Edge;

interface EdgeConfirmState {
  items: { depId: string; taskId: string; from: string; to: string }[];
  resolve: (ok: boolean) => void;
}

function FlowCanvas({ tasks, edges, edgesLoading, mutations, onRequestDelete }: FlowBoardViewProps) {
  const prefs = useViewPrefsStore();
  const update = useViewPrefsStore((state) => state.update);
  const openTask = useShellStore((state) => state.openTask);
  const { fitView } = useReactFlow();

  const cardById = useMemo(() => new Map(tasks.map((task) => [task.id, task])), [tasks]);
  const ids = useMemo(() => tasks.map((task) => task.id), [tasks]);
  const edgeIndex = useMemo(() => new Map(edges.map((edge) => [edge.depId, edge])), [edges]);

  /* 布局持久化（§6.4.9）：首帧等 prefs 水合，避免默认布局覆盖已保存位置。 */
  const [layout, setLayout] = useState<FlowLayout>(() => getFlowLayout());
  const [layoutReady, setLayoutReady] = useState(false);
  useEffect(() => {
    let cancelled = false;
    void hydrateFlowLayout().then((saved) => {
      if (cancelled) return;
      setLayout(saved);
      setLayoutReady(true);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  /* §6.4.9 性能档位：小档全渲染；中档虚拟化 + 阈值以上简化节点；大档提示筛选。 */
  const total = tasks.length;
  const simplified = total >= prefs.simplifyThreshold;
  const nodeHeight = simplified ? FLOW_NODE_SIMPLE_HEIGHT : FLOW_NODE_HEIGHT;

  /* 高亮（§6.4.5 / §6.4.6）：开关来自设置默认，流程图工具栏可临时拨动（写回同一偏好）。 */
  const critical = useMemo(
    () => (prefs.highlightCritical ? criticalPath(ids, edges) : { nodes: new Set<string>(), edges: new Set<string>() }),
    [prefs.highlightCritical, ids, edges],
  );
  const blocked = useMemo(
    () =>
      prefs.highlightBlocked
        ? blockingChain(ids, edges, (id) => {
            const card = cardById.get(id);
            return card ? card.status === 'BLOCKED' || card.blocked.count > 0 : false;
          })
        : { nodes: new Set<string>(), edges: new Set<string>() },
    [prefs.highlightBlocked, ids, edges, cardById],
  );

  /* 聚焦（§6.4.7）：锚点 + 上/下/全链路，范围外节点整卡隐藏。 */
  const [focus, setFocus] = useState<{ anchor: string; scope: 'up' | 'down' | 'all' } | null>(null);
  const visibleIds = useMemo(() => {
    if (!focus) return null;
    return focusSet(focus.anchor, focus.scope, ids, edges);
  }, [focus, ids, edges]);

  /* 分层布局：Kahn 拓扑分层（复用依赖图算法），LR 时交换 x/y 实现「从左到右」。 */
  const positioned = useMemo(() => {
    const layoutInput = visibleIds ? tasks.filter((task) => visibleIds.has(task.id)) : tasks;
    const graph = computeDependencyLayout(
      layoutInput.map((task) => ({
        id: task.id,
        title: task.title,
        status: task.status,
        priority: task.priority,
        progress: task.progress,
      })),
      edges,
      { nodeHeight, gapY: Math.max(64, nodeHeight) },
    );
    return graph.nodes.map((node) => {
      const saved = layout[node.id];
      const rotated = prefs.flowDirection === 'LR' ? { x: node.y, y: node.x } : { x: node.x, y: node.y };
      return { ...node, position: saved ?? rotated };
    });
  }, [tasks, edges, nodeHeight, layout, prefs.flowDirection, visibleIds]);

  const baseNodes = useMemo<FlowNode[]>(
    () =>
      positioned.map((node) => ({
        id: node.id,
        type: 'task' as const,
        position: node.position,
        data: {
          taskId: node.id,
          title: node.title,
          status: node.status,
          priority: node.priority,
          progress: node.progress,
          blockedCount: cardById.get(node.id)?.blocked.count ?? 0,
          agentName: cardById.get(node.id)?.agent_name ?? null,
          simplified,
          onCritical: critical.nodes.has(node.id),
          onBlocking: blocked.nodes.has(node.id),
          dimmed: false,
          direction: prefs.flowDirection,
        },
      })),
    [positioned, cardById, simplified, critical, blocked, prefs.flowDirection],
  );

  const baseEdges = useMemo<FlowEdge[]>(
    () =>
      edges
        .filter((edge) => {
          const ends = (!visibleIds || (visibleIds.has(edge.from) && visibleIds.has(edge.to))) &&
            cardById.has(edge.from) && cardById.has(edge.to);
          return ends;
        })
        .map((edge) => ({
          id: edge.depId,
          source: edge.from,
          target: edge.to,
          type: 'dep' as const,
          data: {
            depType: edge.type,
            onCritical: critical.edges.has(edge.depId),
            onBlocking: blocked.edges.has(edge.depId),
            dimmed: false,
          },
        })),
    [edges, visibleIds, cardById, critical, blocked],
  );

  const [nodes, setNodes, onNodesChange] = useNodesState<FlowNode>([]);
  const [rfEdges, setRfEdges, onEdgesChange] = useEdgesState<FlowEdge>([]);
  const nodesRef = useRef<FlowNode[]>([]);
  nodesRef.current = nodes;

  /* 数据/偏好变化后重建画布元素：保留正在拖拽节点的临时位置，避免 WS 刷新把拖拽拽回去。 */
  useEffect(() => {
    if (!layoutReady) return;
    setNodes((current) => {
      // WS 刷新重建时保留两样「正在进行」的本地态：拖拽中的临时位置、已选中集合（详情 Panel 不闪断）。
      const previous = new Map(current.map((node) => [node.id, node]));
      return baseNodes.map((node) => {
        const before = previous.get(node.id);
        if (!before) return node;
        return { ...node, position: before.dragging ? before.position : node.position, selected: before.selected };
      });
    });
    setRfEdges(baseEdges);
  }, [baseNodes, baseEdges, setNodes, setRfEdges, layoutReady]);

  /* fitView 时机：`fitView` prop 在节点尺寸测量前触发会算错视口（真实浏览器 960×720 实测），
   * 首帧节点到位后主动补一次；换方向/重排布局后同样复位。 */
  const fittedRef = useRef(false);
  useEffect(() => {
    if (!layoutReady || baseNodes.length === 0 || fittedRef.current) return;
    fittedRef.current = true;
    const timer = setTimeout(() => void fitView({ padding: 0.15, duration: 250 }), 120);
    return () => clearTimeout(timer);
  }, [layoutReady, baseNodes.length, fitView]);
  useEffect(() => {
    fittedRef.current = false;
  }, [prefs.flowDirection]);

  /* 交互模式（§6.4.10）：拖画布=平移（默认，§6.4.8 拖拽空白平移）/ 拖画布=框选。 */
  const [interactMode, setInteractMode] = useState<'pan' | 'select'>('pan');

  const addDependency = useAddDependency();
  const removeDependency = useRemoveDependency();
  const groups = useActiveGroups();

  /* 删除确认（§6.4.10 selectable/deletable 基础上的任务语义）：
   * 节点删除交给看板页既有 DeleteDialog（数据删除必须确认 + 有级联说明），
   * onBeforeDelete 直接取消 xyflow 的本地移除；边删除弹轻量确认后走 removeDependency。 */
  const [edgeConfirm, setEdgeConfirm] = useState<EdgeConfirmState | null>(null);
  const onBeforeDelete = useCallback<OnBeforeDelete<FlowNode, FlowEdge>>(
    async ({ nodes: deletedNodes, edges: deletedEdges }) => {
      if (deletedNodes.length > 0) {
        const card = cardById.get(deletedNodes[0]!.id);
        if (card) onRequestDelete(card);
        return false; // 节点删除走看板 DeleteDialog 的确认流，取消 xyflow 本地移除
      }
      if (deletedEdges.length > 0) {
        const items = deletedEdges.flatMap((edge) => {
          const input = edgeIndex.get(edge.id);
          return input ? [{ depId: input.depId, taskId: input.to, from: input.from, to: input.to }] : [];
        });
        if (items.length === 0) return false;
        return await new Promise<boolean>((resolve) => setEdgeConfirm({ items, resolve }));
      }
      return true;
    },
    [cardById, edgeIndex, onRequestDelete],
  );
  const answerEdgeConfirm = (ok: boolean) => {
    setEdgeConfirm((current) => {
      current?.resolve(ok);
      return null;
    });
  };
  const onEdgesDelete = useCallback(
    (deleted: FlowEdge[]) => {
      for (const edge of deleted) {
        const input = edgeIndex.get(edge.id);
        if (input) removeDependency.mutate({ taskId: input.to, depId: input.depId });
      }
    },
    [edgeIndex, removeDependency],
  );

  /* 拖拽连线 = 建依赖（§6.4.10「Handle 自定义」的业务化：源节点是前置）。 */
  const onConnect = useCallback(
    (connection: Connection) => {
      if (!connection.source || !connection.target || connection.source === connection.target) return;
      // 依赖变化由 useAddDependency 的失效链（board/tasks key）刷新，这里不重复处理。
      addDependency.mutate({ taskId: connection.target, dependsOn: connection.source, type: 'blocks' });
    },
    [addDependency],
  );

  /* 布局持久化：拖拽结束把全部节点坐标写 prefs `board.flow.layout`。 */
  const onNodeDragStop = useCallback(() => {
    if (!prefs.persistLayout) return;
    const next: FlowLayout = { ...layout };
    for (const node of nodesRef.current) next[node.id] = { x: node.position.x, y: node.position.y };
    setLayout(next);
    writeFlowLayout(next);
  }, [prefs.persistLayout, layout]);

  /* 节点双击 → 详情抽屉（§6.4.8）；单击选中由 xyflow 原生处理并驱动下方详情面板。 */
  const onNodeDoubleClick = useCallback(
    (_event: React.MouseEvent, node: FlowNode) => openTask(node.id),
    [openTask],
  );

  /* 右键菜单（§6.4.8）：查看/编辑、移到其他分组、删除。 */
  const [menu, setMenu] = useState<{ x: number; y: number; card: TaskCard } | null>(null);
  const [moveMenu, setMoveMenu] = useState(false);
  const onNodeContextMenu = useCallback(
    (event: React.MouseEvent, node: FlowNode) => {
      event.preventDefault();
      const card = cardById.get(node.id);
      if (!card) return;
      setMoveMenu(false);
      setMenu({ x: event.clientX, y: event.clientY, card });
    },
    [cardById],
  );
  useEffect(() => {
    if (!menu) return;
    const close = () => {
      setMenu(null);
      setMoveMenu(false);
    };
    const onKey = (event: KeyboardEvent) => event.key === 'Escape' && close();
    window.addEventListener('pointerdown', close);
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('pointerdown', close);
      window.removeEventListener('keydown', onKey);
    };
  }, [menu]);

  // 选中集直接读受控 nodes 状态（onNodesChange 会把 select 变更写回来），不再另挂 store 订阅。
  const selectedIds = useMemo(() => nodes.filter((node) => node.selected).map((node) => node.id), [nodes]);
  const detailCard = selectedIds.length === 1 ? cardById.get(selectedIds[0]!) : undefined;

  const minZoom = prefs.zoomMinPercent / 100;
  const maxZoom = prefs.zoomMaxPercent / 100;

  return (
    <div className="relative flex min-h-0 flex-1 flex-col gap-2 pt-3" data-testid="flow-view">
      {/* §6.4.2 顶栏：方向 / 关键路径 / 阻塞链 / 聚焦 / 交互模式（组织与筛选沿用共享工具栏）。 */}
      <div className="flex shrink-0 flex-wrap items-center gap-x-3 gap-y-2" onDoubleClick={(event) => event.stopPropagation()}>
        <label className="flex items-center gap-1.5 text-aux text-text-secondary">
          方向
          <select
            value={prefs.flowDirection}
            onChange={(event) => update({ flowDirection: event.target.value === 'LR' ? 'LR' : 'TB' })}
            aria-label="流程图方向"
            className="h-7 rounded-control border border-border bg-bg-surface px-1.5 text-aux text-text-primary"
          >
            <option value="TB">从上到下 ↓</option>
            <option value="LR">从左到右 →</option>
          </select>
        </label>
        <Toggle checked={prefs.highlightCritical} onChange={(value) => update({ highlightCritical: value })} label="关键路径" />
        <Toggle checked={prefs.highlightBlocked} onChange={(value) => update({ highlightBlocked: value })} label="阻塞链" />
        <span aria-hidden className="h-5 w-px bg-border" />
        <button
          type="button"
          onClick={() => setInteractMode((mode) => (mode === 'pan' ? 'select' : 'pan'))}
          className="inline-flex h-7 items-center gap-1 rounded-control border border-border px-2 text-aux text-text-secondary hover:bg-bg-muted hover:text-text-primary"
          aria-pressed={interactMode === 'select'}
          title="切换拖拽空白处的手势：平移画布 / 框选多节点（另一手势保留给鼠标中键/右键）"
        >
          {interactMode === 'pan' ? <Move className="size-3.5" aria-hidden /> : <SquareDashed className="size-3.5" aria-hidden />}
          拖拽：{interactMode === 'pan' ? '平移画布' : '框选多选'}
        </button>
        <button
          type="button"
          onClick={() => {
            setLayout({});
            writeFlowLayout({});
            // fitView 即 §6.4.10 的 zoomToExtent（全图复位），同一条实例方法。
            void fitView({ padding: 0.2, duration: 200 });
          }}
          className="inline-flex h-7 items-center gap-1 rounded-control border border-border px-2 text-aux text-text-secondary hover:bg-bg-muted hover:text-text-primary"
        >
          <Locate className="size-3.5" aria-hidden />
          重排布局
        </button>
        {focus ? (
          <span className="inline-flex items-center gap-1 rounded-control border border-primary bg-primary-light px-2 py-0.5 text-aux text-primary">
            🔍 聚焦: {focus.anchor}
            {(['up', 'down', 'all'] as const).map((scope) => (
              <button
                key={scope}
                type="button"
                onClick={() => setFocus({ ...focus, scope })}
                className={cn(
                  'rounded-tag px-1 hover:underline',
                  focus.scope === scope ? 'font-semibold' : 'text-text-secondary',
                )}
              >
                {scope === 'up' ? '上游' : scope === 'down' ? '下游' : '全链路'}
              </button>
            ))}
            <button type="button" onClick={() => setFocus(null)} className="rounded-tag px-1 font-semibold hover:underline">
              显示全部
            </button>
          </span>
        ) : (
          <span className="text-aux text-text-tertiary">
            {total > 0 ? '选中一个节点后可聚焦上游/下游' : ''}
          </span>
        )}
      </div>

      {/* 画布本体 */}
      <div className="relative min-h-0 flex-1 overflow-hidden rounded-card border border-border bg-bg-raised">
        {total > prefs.perfLargeLimit ? (
          <div className="absolute inset-x-0 top-0 z-10 bg-status-running-soft px-4 py-1 text-aux text-text-primary">
            节点数 {total} 已超过性能档位上限（{prefs.perfLargeLimit}）：已开启虚拟化渲染，建议用分组切换器或筛选收窄范围。
          </div>
        ) : null}
        <ReactFlow
          nodes={nodes}
          edges={rfEdges}
          onNodesChange={onNodesChange}
          onEdgesChange={onEdgesChange}
          nodeTypes={NODE_TYPES}
          edgeTypes={EDGE_TYPES}
          minZoom={minZoom}
          maxZoom={maxZoom}
          fitView
          fitViewOptions={{ padding: 0.2, maxZoom: 1 }}
          snapToGrid
          snapGrid={[10, 10]}
          onlyRenderVisibleElements={total >= prefs.perfSmallLimit}
          nodesDraggable
          nodesConnectable
          elementsSelectable
          multiSelectionKeyCode={['Meta', 'Control', 'Shift']}
          deleteKeyCode={['Delete', 'Backspace']}
          selectionMode={SelectionMode.Partial}
          panOnDrag={interactMode === 'pan' ? [0, 1, 2] : [1, 2]}
          selectionOnDrag={interactMode === 'select'}
          zoomOnScroll
          zoomOnPinch
          panOnScroll={false}
          onBeforeDelete={onBeforeDelete}
          onEdgesDelete={onEdgesDelete}
          onConnect={onConnect}
          onNodeDragStop={onNodeDragStop}
          onNodeDoubleClick={onNodeDoubleClick}
          onNodeContextMenu={onNodeContextMenu}
          onDoubleClick={(_event) => {
            /* §6.4.8 双击空白 = 适应屏幕（xyflow 无专门回调，按事件目标判定空白）。 */
            const target = _event.target as HTMLElement;
            if (target.classList.contains('react-flow__pane')) {
              void fitView({ padding: 0.2, duration: 200 });
            }
          }}
          proOptions={{ hideAttribution: false }}
          data-testid="flow-canvas"
        >
          <Background variant={BackgroundVariant.Dots} gap={20} size={1.5} color="var(--color-border-strong)" />
          <MiniMap
            pannable
            zoomable
            className="!bg-bg-surface"
            nodeStrokeWidth={2}
            nodeColor={(node) => statusColor((node.data as TaskFlowNodeData | undefined)?.status ?? '')}
          />
          {/* Controls：缩放 / 适应 / 锁定交互，替代旧依赖图的自绘按钮（§6.4.10）。 */}
          <Controls showInteractive />
          {/* §6.4.2 底栏图例（Panel 承载）。bottom-center + pointer-events-none：
              bottom-left 会被 Controls 按钮组压住（960px 实测挡住 fitView/zoom 点击）。 */}
          <Panel position="bottom-center">
            <div className="pointer-events-none flex max-w-[70vw] flex-wrap items-center justify-center gap-x-4 gap-y-1 rounded-card border border-border bg-bg-surface/90 px-3 py-1.5 text-aux text-text-secondary">
              {Object.entries(STATUS_LABEL).map(([status, label]) => (
                <span key={status} className="inline-flex items-center gap-1.5">
                  <span aria-hidden className="size-2 rounded-full" style={{ background: statusColor(status) }} />
                  {label}
                </span>
              ))}
              <span className="inline-flex items-center gap-1.5">
                <svg width="24" height="6" aria-hidden>
                  <line x1="0" y1="3" x2="24" y2="3" stroke="var(--color-border-strong)" strokeWidth="2" />
                </svg>
                阻塞
              </span>
              <span className="inline-flex items-center gap-1.5">
                <svg width="24" height="6" aria-hidden>
                  <line x1="0" y1="3" x2="24" y2="3" stroke="var(--color-border-strong)" strokeWidth="2" strokeDasharray="5 4" />
                </svg>
                关联
              </span>
              <span className="inline-flex items-center gap-1.5 text-status-running">══ 关键路径</span>
              <span className="inline-flex items-center gap-1.5 text-status-failed">═ 阻塞链</span>
            </div>
          </Panel>
          {/* 详情 Panel（§6.4.8 单击=选中并显示详情；多选给计数）。 */}
          <Panel position="top-right" className="mt-12">
            {edgesLoading ? (
              <div className="flex items-center gap-1.5 rounded-card border border-border bg-bg-surface/95 px-3 py-1.5 text-aux text-text-secondary">
                <Loader2 className="size-3.5 animate-spin" aria-hidden /> 正在加载依赖…
              </div>
            ) : selectedIds.length > 1 ? (
              <div className="rounded-card border border-border bg-bg-surface/95 px-3 py-1.5 text-aux text-text-primary">
                已多选 {selectedIds.length} 个节点
              </div>
            ) : detailCard ? (
              <div className="w-56 rounded-card border border-border bg-bg-surface/95 px-3 py-2 text-aux shadow-card">
                <div className="flex items-center justify-between gap-2">
                  <span className="truncate font-mono text-[10px] text-text-tertiary">{detailCard.id}</span>
                  <span className="shrink-0 text-text-secondary">{STATUS_LABEL[detailCard.status as keyof typeof STATUS_LABEL] ?? detailCard.status_label}</span>
                </div>
                <div className="mt-1 line-clamp-2 text-body text-text-primary">{detailCard.title}</div>
                <div className="mt-1 text-text-tertiary">
                  P{detailCard.priority}
                  {detailCard.agent_name ? ` · ${detailCard.agent_name}` : ''}
                  {detailCard.blocked.count > 0 ? ` · 被 ${detailCard.blocked.count} 个前置阻塞` : ''}
                </div>
                <button
                  type="button"
                  onClick={() => setFocus({ anchor: detailCard.id, scope: 'all' })}
                  className="mt-1.5 w-full rounded-control border border-border py-1 text-text-secondary hover:bg-bg-muted hover:text-text-primary"
                >
                  聚焦全链路
                </button>
              </div>
            ) : null}
          </Panel>
        </ReactFlow>
        {total === 0 ? (
          <div className="pointer-events-none absolute inset-0 flex items-center justify-center text-body text-text-tertiary">
            当前筛选下没有任务，流程图无从画起
          </div>
        ) : null}
      </div>

      {/* 右键菜单（§6.4.8）：查看/编辑 · 移到其他分组 · 删除（复用看板确认对话框） */}
      {menu ? (
        <div
          className="fixed z-50 w-48 rounded-card border border-border bg-bg-surface py-1 shadow-card"
          style={{ left: Math.min(menu.x, window.innerWidth - 200), top: Math.min(menu.y, window.innerHeight - 180) }}
          onPointerDown={(event) => event.stopPropagation()}
          data-testid="flow-context-menu"
        >
          <MenuItem
            label="查看 / 编辑详情"
            onClick={() => {
              openTask(menu.card.id);
              setMenu(null);
            }}
          />
          <MenuItem
            label={moveMenu ? '▾ 移到其他分组' : '▸ 移到其他分组'}
            onClick={() => setMoveMenu((value) => !value)}
          />
          {moveMenu ? (
            <div className="max-h-48 overflow-y-auto border-t border-border">
              {(groups.data?.items ?? [])
                .filter((group) => group.id !== menu.card.group_id)
                .map((group) => (
                  <MenuItem
                    key={group.id}
                    label={`📁 ${group.name}`}
                    onClick={() => {
                      mutations.patch.mutate(
                        { id: menu.card.id, body: { group_id: group.id } },
                        { onSuccess: () => setMenu(null) },
                      );
                    }}
                  />
                ))}
            </div>
          ) : null}
          <MenuItem
            label="删除任务…"
            danger
            onClick={() => {
              onRequestDelete(menu.card);
              setMenu(null);
            }}
          />
        </div>
      ) : null}

      {/* 边删除确认：文案对齐旧依赖图弹窗（删除 blocks 边可能立即解锁下游）。 */}
      {edgeConfirm ? (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/30" role="dialog" aria-modal="true">
          <div className="w-[420px] rounded-card border border-border bg-bg-surface p-5 shadow-card">
            <h3 className="text-section-title text-text-primary">删除依赖</h3>
            <ul className="mt-2 space-y-1 text-body text-text-secondary">
              {edgeConfirm.items.map((item) => (
                <li key={item.depId} className="font-mono text-code">
                  {item.from} → {item.to}
                </li>
              ))}
            </ul>
            <p className="mt-2 text-aux text-text-tertiary">删除后下游任务可能立即变为可领取状态。</p>
            <div className="mt-4 flex justify-end gap-2">
              <button type="button" className="rounded-control border border-border px-3 py-1.5 text-body text-text-secondary hover:bg-bg-muted" onClick={() => answerEdgeConfirm(false)}>
                取消
              </button>
              <button type="button" className="rounded-control bg-status-failed px-3 py-1.5 text-body text-text-inverse hover:opacity-90" onClick={() => answerEdgeConfirm(true)}>
                删除
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}

function Toggle({ checked, onChange, label }: { checked: boolean; onChange: (value: boolean) => void; label: string }) {
  return (
    <label className="inline-flex cursor-pointer items-center gap-1.5 text-aux text-text-secondary">
      <input
        type="checkbox"
        checked={checked}
        onChange={(event) => onChange(event.target.checked)}
        className="size-3.5 accent-[var(--color-primary)]"
      />
      高亮{label}
    </label>
  );
}

function MenuItem({ label, onClick, danger }: { label: string; onClick: () => void; danger?: boolean }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        'block w-full px-3 py-1.5 text-left text-body hover:bg-bg-muted',
        danger ? 'text-status-failed' : 'text-text-primary',
      )}
    >
      {label}
    </button>
  );
}
