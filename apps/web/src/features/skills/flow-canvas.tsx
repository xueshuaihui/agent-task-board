import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Background,
  BackgroundVariant,
  BaseEdge,
  Controls,
  EdgeLabelRenderer,
  Handle,
  MiniMap,
  Panel,
  Position,
  ReactFlow,
  ReactFlowProvider,
  getSmoothStepPath,
  useReactFlow,
  type Edge,
  type EdgeChange,
  type EdgeProps,
  type Node,
  type NodeChange,
  type NodeProps,
  type OnBeforeDelete,
} from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import { Flag, LayoutGrid, Pencil, Plus, Trash2, TriangleAlert } from 'lucide-react';
import { cn } from '@/lib/cn';
import { Button, Drawer, Field, IconButton, Input } from '@/components/ui';
import { BLOCK_KIND_META, blockTitle, createBlock, cyclicBlockIds, inferVariableOptions } from './meta';
import { BlockFields } from './block-fields';
import {
  FLOW_NODE_HEIGHT,
  FLOW_NODE_WIDTH,
  autoLayoutBlocks,
  ensureBlockPos,
  outgoingEdges,
  removeBlockWithRefs,
  removeEdgeTarget,
  setEdgeTarget,
  setEntryBlock,
} from './flow-model';
import type { SkillBlock, SkillBlockKind, SkillContent } from './types';

/**
 * 流程图画布（React Flow / @xyflow/react 重写版）：
 * - 节点 = 块（自定义节点：图标 + 标题 + 类型徽标 + 入口标识），拖拽松手写回 block.pos；
 * - 边 = next 指针（从输出 Handle 拖线建立，onConnect 写回 setEdgeTarget）；
 *   decision 多分支每分支一个 Handle（label=when），普通块单 Handle，底部输入 Handle；
 * - 点选边出现删除按钮（Delete/Backspace 键同样可删），禁自连、重复连覆盖；
 * - 面板点击/HTML5 拖拽添加 15 类块，框选多选、对齐吸附、MiniMap、Controls、
 *   dot grid 背景（@theme token 色）、fitView、自动整理（autoLayoutBlocks）；
 * - cyclicBlockIds 检测到的环上节点与边标红（样式类 rf-cyclic），顶部警示条保留；
 *   「设为入口」：节点右键或悬停工具按钮。
 *
 * 所有编辑实时写回与其他三种模式共享的同一份 blocks 草稿（onChange），脏态/自动保存
 * 沿用 skill-editor-page 现有机制；pos 是 passthrough JSON 上的附加字段，后端无感知。
 */

const KIND_ORDER = Object.keys(BLOCK_KIND_META) as SkillBlockKind[];

/** 节点左侧色条 / 图标 chip 的静态类名（Tailwind 需要字面量，不能拼 kindClass）。 */
const KIND_CHIP_CLASS: Record<SkillBlockKind, string> = {
  prompt: 'bg-primary-light text-primary',
  step: 'bg-status-ready-soft text-status-ready',
  decision: 'bg-status-review-soft text-status-review',
  loop: 'bg-status-review-soft text-status-review',
  parallel: 'bg-status-running-soft text-status-running',
  tool: 'bg-bg-muted text-text-secondary',
  knowledge: 'bg-status-done-soft text-status-done',
  script: 'bg-status-running-soft text-status-running',
  subskill: 'bg-primary-light text-primary',
  human: 'bg-status-failed-soft text-status-failed',
  input: 'bg-status-ready-soft text-status-ready',
  output: 'bg-status-done-soft text-status-done',
  constraint: 'bg-status-backlog-soft text-status-backlog',
  error_handler: 'bg-status-failed-soft text-status-failed',
  comment: 'bg-bg-muted text-text-secondary',
};

/** MiniMap 节点填色：直接引用 @theme token 变量（明暗主题自动跟随）。 */
const KIND_MINIMAP_COLOR: Record<SkillBlockKind, string> = {
  prompt: 'var(--color-primary)',
  step: 'var(--color-status-ready)',
  decision: 'var(--color-status-review)',
  loop: 'var(--color-status-review)',
  parallel: 'var(--color-status-running)',
  tool: 'var(--color-border-strong)',
  knowledge: 'var(--color-status-done)',
  script: 'var(--color-status-running)',
  subskill: 'var(--color-primary)',
  human: 'var(--color-status-failed)',
  input: 'var(--color-status-ready)',
  output: 'var(--color-status-done)',
  constraint: 'var(--color-status-backlog)',
  error_handler: 'var(--color-status-failed)',
  comment: 'var(--color-border-strong)',
};

const DND_KIND_MIME = 'application/x-atb-skill-block-kind';

/** 边 id：`fromId#branchIndex`，从 Handle id `out-N` 与边 id 双向解析分支序号。 */
function edgeId(fromId: string, branchIndex: number): string {
  return `${fromId}#${branchIndex}`;
}

function branchIndexOfEdge(id: string): number {
  const index = Number.parseInt(id.slice(id.lastIndexOf('#') + 1), 10);
  return Number.isFinite(index) ? index : 0;
}

function branchOfHandle(handleId: string | null | undefined): number {
  const match = /^out-(\d+)$/.exec(handleId ?? '');
  return match ? Number.parseInt(match[1], 10) : 0;
}

/* ------------------------------ 自定义节点 ------------------------------ */

interface SkillNodeData extends Record<string, unknown> {
  block: SkillBlock;
  isEntry: boolean;
  isCyclic: boolean;
  readOnly: boolean;
  onSetEntry: (id: string) => void;
  onDelete: (id: string) => void;
  onOpen: (id: string) => void;
}

type SkillFlowNode = Node<SkillNodeData, 'skill'>;

function SkillNodeView({ id, data, selected }: NodeProps<SkillFlowNode>) {
  const { block, isEntry, isCyclic, readOnly, onSetEntry, onDelete, onOpen } = data;
  const meta = BLOCK_KIND_META[block.kind];
  const Icon = meta.icon;
  const nexts = block.next ?? [];
  // 单分支（或无 next）一个输出锚点，多分支（decision 等）沿底边均布并标注 when。
  const anchors =
    nexts.length <= 1
      ? [{ branchIndex: 0, label: '' }]
      : nexts.map((next, branchIndex) => ({ branchIndex, label: next.when }));

  return (
    <div
      className={cn(
        'group h-full rounded-[10px] border bg-bg-surface px-2.5 shadow-node',
        !readOnly && 'cursor-grab active:cursor-grabbing',
        isEntry ? 'border-primary' : 'border-border',
        isCyclic && 'rf-cyclic-node border-dashed',
        selected && 'ring-2 ring-primary ring-offset-1 ring-offset-bg-raised',
      )}
      style={{ height: FLOW_NODE_HEIGHT }}
      onDoubleClick={() => {
        if (!readOnly) onOpen(id);
      }}
      onContextMenu={(event) => {
        event.preventDefault();
        if (!readOnly && !isEntry) onSetEntry(id);
      }}
      title={readOnly ? '默认技能只读，仅查看' : '拖拽移动 · 双击编辑 · 右键设为入口'}
    >
      <Handle type="target" position={Position.Top} id="in" className="rf-handle" isConnectableStart={false} />
      <div className="flex h-full items-center gap-2">
        <span className={cn('flex size-7 shrink-0 items-center justify-center rounded-control', KIND_CHIP_CLASS[block.kind])}>
          <Icon className="size-4" />
        </span>
        <span className="min-w-0 flex-1">
          <span className="block truncate text-caption text-text-primary">{blockTitle(block, 0)}</span>
          <span className="block truncate text-[10px] text-text-tertiary">{meta.label}</span>
        </span>
        {/* 悬浮工具条浮在块右上角，不占行内宽度——留在行内会把标题挤到只剩一两个字。只读态隐藏。 */}
        {!readOnly ? (
        <span className="absolute -top-3 right-1 z-20 flex items-center gap-0.5 rounded-full border border-border bg-bg-surface px-0.5 opacity-0 shadow-card transition-opacity group-hover:opacity-100 group-focus-within:opacity-100">
          <IconButton
            label="编辑块"
            variant="ghost"
            size="icon"
            className="size-6"
            onPointerDown={(event) => event.stopPropagation()}
            onClick={() => onOpen(id)}
            icon={<Pencil className="size-3.5" />}
          />
          <IconButton
            label="设为入口"
            variant="ghost"
            size="icon"
            className="size-6"
            disabled={isEntry}
            onPointerDown={(event) => event.stopPropagation()}
            onClick={() => onSetEntry(id)}
            icon={<Flag className="size-3.5" />}
          />
          <IconButton
            label="删除块"
            variant="ghost"
            size="icon"
            className="size-6 hover:text-status-failed"
            onPointerDown={(event) => event.stopPropagation()}
            onClick={() => onDelete(id)}
            icon={<Trash2 className="size-3.5" />}
          />
        </span>
        ) : null}
      </div>
      {isEntry ? (
        <span className="absolute -top-2 left-2 z-10 rounded-badge bg-primary px-1.5 py-px text-[9px] text-white">
          入口
        </span>
      ) : null}
      {anchors.map((anchor) => (
        <span key={anchor.branchIndex}>
          <Handle
            type="source"
            position={Position.Bottom}
            id={`out-${anchor.branchIndex}`}
            className="rf-handle"
            style={{ left: `${((anchor.branchIndex + 1) / (anchors.length + 1)) * 100}%` }}
          />
          {anchor.label ? (
            <span
              className="absolute top-full mt-1.5 -translate-x-1/2 whitespace-nowrap text-[9px] leading-none text-text-tertiary"
              style={{ left: `${((anchor.branchIndex + 1) / (anchors.length + 1)) * 100}%` }}
            >
              {anchor.label}
            </span>
          ) : null}
        </span>
      ))}
    </div>
  );
}

const nodeTypes = { skill: SkillNodeView };

/* ------------------------------ 自定义边 ------------------------------ */

interface FlowEdgeData extends Record<string, unknown> {
  fromId: string;
  branchIndex: number;
  when: string;
  cyclic: boolean;
  readOnly: boolean;
  onDelete: (fromId: string, branchIndex: number) => void;
}

type SkillFlowEdge = Edge<FlowEdgeData, 'flow'>;

function FlowEdgeView({ id, sourceX, sourceY, targetX, targetY, sourcePosition, targetPosition, selected, data }: EdgeProps<SkillFlowEdge>) {
  const [path, labelX, labelY] = getSmoothStepPath({
    sourceX,
    sourceY,
    sourcePosition,
    targetX,
    targetY,
    targetPosition,
    borderRadius: 12,
  });

  return (
    <>
      <BaseEdge
        id={id}
        path={path}
        className={cn(data?.cyclic && 'rf-cyclic-edge')}
      />
      <EdgeLabelRenderer>
        {(data?.when || selected) && data ? (
          <div
            className="nodrag nopan pointer-events-none absolute flex items-center gap-1"
            style={{ transform: `translate(-50%,-50%) translate(${labelX}px,${labelY}px)` }}
          >
            {data.when ? (
              <span
                className={cn(
                  'pointer-events-auto rounded-badge border bg-bg-surface px-1.5 py-px text-[9px] leading-4',
                  selected ? 'border-primary text-primary' : 'border-border text-text-tertiary',
                  data.cyclic && 'border-status-failed/40 text-status-failed',
                )}
              >
                {data.when}
              </span>
            ) : null}
            {selected && !data.readOnly ? (
              <button
                type="button"
                aria-label="删除连线"
                title="删除连线"
                className="pointer-events-auto flex size-4.5 items-center justify-center rounded-full border border-border bg-bg-surface text-text-tertiary hover:border-status-failed hover:text-status-failed"
                onPointerDown={(event) => event.stopPropagation()}
                onClick={(event) => {
                  event.stopPropagation();
                  data.onDelete(data.fromId, data.branchIndex);
                }}
              >
                <Trash2 className="size-2.5" />
              </button>
            ) : null}
          </div>
        ) : null}
      </EdgeLabelRenderer>
    </>
  );
}

const edgeTypes = { flow: FlowEdgeView };

/* ------------------------------ 画布主体 ------------------------------ */

export interface SkillFlowEditorProps {
  content: SkillContent;
  onChange: (next: SkillContent) => void;
  className?: string;
  /** W3 §9.1：默认技能只读——画布不可拖拽/连线/增删，仅查看拓扑。 */
  readOnly?: boolean;
}

export function SkillFlowEditor({ content, onChange, className, readOnly = false }: SkillFlowEditorProps) {
  return (
    <ReactFlowProvider>
      <FlowCanvas content={content} onChange={onChange} className={className} readOnly={readOnly} />
    </ReactFlowProvider>
  );
}

function FlowCanvas({ content, onChange, className, readOnly = false }: SkillFlowEditorProps) {
  const { screenToFlowPosition, fitView } = useReactFlow();

  /* refs 镜像最新值，供稳定回调里读取而不吃陈旧闭包（onChange 是页面内联函数，不稳定）。 */
  const contentRef = useRef(content);
  contentRef.current = content;
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;
  const readOnlyRef = useRef(readOnly);
  readOnlyRef.current = readOnly;

  /** 所有对草稿的写回统一走 emit：只读态直接吞掉（双保险，UI 层同时隐藏操作）。 */
  const emit = useCallback((next: SkillContent) => {
    if (readOnlyRef.current) return;
    onChangeRef.current(next);
  }, []);

  const [livePos, setLivePos] = useState<Record<string, { x: number; y: number }>>({});
  const livePosRef = useRef(livePos);
  const [selectedNodeIds, setSelectedNodeIds] = useState<ReadonlySet<string>>(() => new Set());
  const selectedNodeIdsRef = useRef(selectedNodeIds);
  const [selectedEdgeIds, setSelectedEdgeIds] = useState<ReadonlySet<string>>(() => new Set());
  const [editingId, setEditingId] = useState<string | null>(null);
  const [dropHint, setDropHint] = useState<SkillBlockKind | null>(null);

  const blocks = content.blocks;
  const byId = useMemo(() => new Map(blocks.map((block) => [block.id, block])), [blocks]);
  const cyclic = useMemo(() => cyclicBlockIds(content), [content]);
  const edgesRef = useMemo(() => outgoingEdges(content), [content]);

  /* 没写 pos 的块兜底用 BFS 网格坐标展示（ensureBlockPos 回写后即有真实 pos）。 */
  const fallbackPos = useMemo(() => {
    const map = new Map<string, { x: number; y: number }>();
    for (const block of ensureBlockPos(content).blocks) {
      if (block.pos) map.set(block.id, block.pos);
    }
    return map;
  }, [content]);

  /* 进入画布时给缺 pos 的块自动分层落位（写回共享草稿，pos 随自动保存持久化）。 */
  useEffect(() => {
    if (blocks.some((block) => !block.pos)) emit(ensureBlockPos(contentRef.current));
  }, [blocks]);

  /* 拖拽过程中的位置覆盖在松手/整理后清掉。 */
  const clearLivePos = useCallback(() => {
    livePosRef.current = {};
    setLivePos({});
  }, []);

  /* ---------------- 稳定回调（全部走 ref，不随草稿重建） ---------------- */

  const patchBlock = useCallback((id: string, patch: Partial<SkillBlock>) => {
    const current = contentRef.current;
    emit({
      ...current,
      blocks: current.blocks.map((block) => (block.id === id ? { ...block, ...patch } : block)),
    });
  }, []);

  const deleteBlockConfirmed = useCallback((id: string) => {
    const block = contentRef.current.blocks.find((item) => item.id === id);
    if (!block) return;
    if (!window.confirm(`删除块「${blockTitle(block, 0)}」？指向它的连线会一并清掉`)) return;
    emit(removeBlockWithRefs(contentRef.current, id));
    setEditingId((prev) => (prev === id ? null : prev));
  }, []);

  const setEntry = useCallback((id: string) => {
    emit(setEntryBlock(contentRef.current, id));
  }, []);

  const openEditor = useCallback((id: string) => setEditingId(id), []);

  const deleteEdge = useCallback((fromId: string, branchIndex: number) => {
    emit(removeEdgeTarget(contentRef.current, fromId, branchIndex));
  }, []);

  const onSetEntryRef = useRef(setEntry);
  onSetEntryRef.current = setEntry;
  const onDeleteRef = useRef(deleteBlockConfirmed);
  onDeleteRef.current = deleteBlockConfirmed;

  /* ---------------- 节点 / 边派生 ---------------- */

  const nodes: SkillFlowNode[] = useMemo(
    () =>
      blocks.map((block) => ({
        id: block.id,
        type: 'skill' as const,
        position: livePos[block.id] ?? block.pos ?? fallbackPos.get(block.id) ?? { x: 0, y: 0 },
        selected: selectedNodeIds.has(block.id),
        style: { width: FLOW_NODE_WIDTH },
        // 显式尺寸：MiniMap 判定「节点可画」看的是 userNode 上的宽高（measured/width/height），
        // 而本画布的 onNodesChange 只处理 position/select、丢弃 dimensions 变更，userNode
        // 永远拿不到 measured —— 不给显式宽高时小地图一个色块都画不出来（空白）。
        // 宽高与节点组件的固定尺寸常量同源，画布渲染不受影响。
        width: FLOW_NODE_WIDTH,
        height: FLOW_NODE_HEIGHT,
        data: {
          block,
          isEntry: block.id === content.entryBlockId,
          isCyclic: cyclic.has(block.id),
          readOnly,
          onSetEntry: (id: string) => onSetEntryRef.current(id),
          onDelete: (id: string) => onDeleteRef.current(id),
          onOpen: openEditor,
        },
      })),
    [blocks, livePos, selectedNodeIds, fallbackPos, content.entryBlockId, cyclic, readOnly, openEditor],
  );

  const edges: SkillFlowEdge[] = useMemo(
    () =>
      edgesRef.map((edge) => ({
        id: edgeId(edge.fromId, edge.branchIndex),
        source: edge.fromId,
        target: edge.toId,
        sourceHandle: `out-${edge.branchIndex}`,
        targetHandle: 'in',
        type: 'flow' as const,
        selected: selectedEdgeIds.has(edgeId(edge.fromId, edge.branchIndex)),
        data: {
          fromId: edge.fromId,
          branchIndex: edge.branchIndex,
          when: edge.when,
          cyclic: cyclic.has(edge.fromId) && cyclic.has(edge.toId),
          readOnly,
          onDelete: deleteEdge,
        },
      })),
    [edgesRef, selectedEdgeIds, cyclic, readOnly, deleteEdge],
  );

  /* ---------------- 受控变更：拖拽位置 / 选中镜像 ---------------- */

  const onNodesChange = useCallback((changes: NodeChange<SkillFlowNode>[]) => {
    let positions: Record<string, { x: number; y: number }> | null = null;
    const selection = new Set(selectedNodeIdsRef.current);
    let selectionChanged = false;
    for (const change of changes) {
      if (change.type === 'position' && change.position) {
        positions ??= { ...livePosRef.current };
        positions[change.id] = change.position;
      } else if (change.type === 'select') {
        selectionChanged = true;
        if (change.selected) selection.add(change.id);
        else selection.delete(change.id);
      }
    }
    if (positions) {
      livePosRef.current = positions;
      setLivePos(positions);
    }
    if (selectionChanged) {
      selectedNodeIdsRef.current = selection;
      setSelectedNodeIds(selection);
    }
  }, []);

  const onEdgeSelections = useCallback((changes: EdgeChange<SkillFlowEdge>[]) => {
    const toggles = changes.filter((change) => change.type === 'select') as Extract<
      EdgeChange<SkillFlowEdge>,
      { type: 'select' }
    >[];
    if (toggles.length === 0) return;
    setSelectedEdgeIds((prev) => {
      const next = new Set(prev);
      for (const change of toggles) {
        if (change.selected) next.add(change.id);
        else next.delete(change.id);
      }
      return next;
    });
  }, []);

  /* 节点拖拽松手：一次性写回 block.pos（拖拽期间只动 livePos，避免狂触发保存）。 */
  const onNodeDragStop = useCallback(
    (_event: unknown, _node: unknown, draggedNodes: SkillFlowNode[]) => {
      let current = contentRef.current;
      for (const node of draggedNodes) {
        current = {
          ...current,
          blocks: current.blocks.map((block) =>
            block.id === node.id
              ? { ...block, pos: { x: Math.round(node.position.x), y: Math.round(node.position.y) } }
              : block,
          ),
        };
      }
      emit(current);
      clearLivePos();
    },
    [clearLivePos],
  );

  /* ---------------- 连线 ---------------- */

  const onConnect = useCallback((connection: { source: string | null; target: string | null; sourceHandle: string | null | undefined }) => {
    if (!connection.source || !connection.target) return;
    if (connection.source === connection.target) return;
    emit(
      setEdgeTarget(contentRef.current, connection.source, branchOfHandle(connection.sourceHandle), connection.target),
    );
  }, []);

  const isValidConnection = useCallback(
    (connection: { source: string | null; target: string | null }) =>
      Boolean(connection.source && connection.target && connection.source !== connection.target),
    [],
  );

  /* ---------------- 删除（键盘 Delete + onNodesDelete/onEdgesDelete） ---------------- */

  const onBeforeDelete = useCallback<OnBeforeDelete<SkillFlowNode, SkillFlowEdge>>(async ({ nodes: deletedNodes }) => {
    if (deletedNodes.length === 0) return true;
    if (deletedNodes.length === 1) {
      const block = deletedNodes[0].data.block;
      return window.confirm(`删除块「${blockTitle(block, 0)}」？指向它的连线会一并清掉`);
    }
    return window.confirm(`删除选中的 ${deletedNodes.length} 个块？指向它们的连线会一并清掉`);
  }, []);

  const onNodesDelete = useCallback(
    (deleted: SkillFlowNode[]) => {
      let current = contentRef.current;
      for (const node of deleted) current = removeBlockWithRefs(current, node.id);
      emit(current);
      const deletedIds = new Set(deleted.map((node) => node.id));
      setEditingId((prev) => (prev && deletedIds.has(prev) ? null : prev));
    },
    [],
  );

  const onEdgesDelete = useCallback((deleted: SkillFlowEdge[]) => {
    let current = contentRef.current;
    for (const edge of deleted) current = removeEdgeTarget(current, edge.source, branchIndexOfEdge(edge.id));
    emit(current);
  }, []);

  /* ---------------- 添加块：面板点击 / HTML5 拖放 ---------------- */

  const addBlock = useCallback(
    (kind: SkillBlockKind, at?: { x: number; y: number }) => {
      const current = contentRef.current;
      const seed = createBlock(kind, current.blocks.length);
      if (at) {
        seed.pos = { x: Math.round(at.x - FLOW_NODE_WIDTH / 2), y: Math.round(at.y - FLOW_NODE_HEIGHT / 2) };
      } else {
        const element = document.querySelector('.atb-rf')?.getBoundingClientRect();
        const center = screenToFlowPosition({
          x: (element?.left ?? 0) + (element?.width ?? 600) / 2,
          y: (element?.top ?? 0) + (element?.height ?? 400) / 2,
        });
        const jitter = (current.blocks.length % 5) * (FLOW_NODE_HEIGHT + 28);
        seed.pos = { x: Math.round(center.x + jitter), y: Math.round(center.y + jitter) };
      }
      emit({
        blocks: [...current.blocks, seed],
        entryBlockId: current.entryBlockId ?? seed.id,
      });
    },
    [screenToFlowPosition],
  );

  const onDrop = useCallback(
    (event: React.DragEvent<HTMLDivElement>) => {
      event.preventDefault();
      if (readOnlyRef.current) return;
      const kind = event.dataTransfer.getData(DND_KIND_MIME) as SkillBlockKind;
      setDropHint(null);
      if (!KIND_ORDER.includes(kind)) return;
      const point = screenToFlowPosition({ x: event.clientX, y: event.clientY });
      addBlock(kind, point);
    },
    [addBlock, screenToFlowPosition],
  );

  /* ---------------- 自动整理 / 适应画布 ---------------- */

  const autoLayout = useCallback(() => {
    emit(autoLayoutBlocks(contentRef.current));
    clearLivePos();
    window.setTimeout(() => void fitView({ padding: 0.2, duration: 200 }), 50);
  }, [clearLivePos, fitView]);

  /* ---------------- 块编辑抽屉 ---------------- */

  const editingBlock = editingId ? byId.get(editingId) : undefined;
  const targetOptions = useMemo(
    () => [
      { value: '', label: '（不跳转）' },
      ...blocks.map((block, index) => ({ value: block.id, label: blockTitle(block, index) })),
    ],
    [blocks],
  );
  const variableOptions = useMemo(() => inferVariableOptions(content), [content]);

  return (
    <div className={cn('flex min-h-0 gap-3', className)}>
      {/* 左侧块类型面板：15 类，点击添加 / 拖到画布落点（HTML5 DnD）。只读态不渲染。 */}
      {!readOnly ? (
      <aside className="atb-scroll flex w-36 shrink-0 flex-col gap-1 overflow-y-auto rounded-card border border-border bg-bg-raised p-2">
        <p className="px-1 pb-1 text-aux text-text-tertiary">块类型</p>
        {KIND_ORDER.map((kind) => {
          const meta = BLOCK_KIND_META[kind];
          const Icon = meta.icon;
          return (
            <button
              key={kind}
              type="button"
              draggable
              onDragStart={(event) => {
                event.dataTransfer.setData(DND_KIND_MIME, kind);
                event.dataTransfer.effectAllowed = 'move';
                setDropHint(kind);
              }}
              onDragEnd={() => setDropHint(null)}
              onClick={() => addBlock(kind)}
              className="flex cursor-grab items-center gap-2 rounded-control px-2 py-1.5 text-left text-aux text-text-secondary hover:bg-bg-muted hover:text-text-primary active:cursor-grabbing"
              title={`${meta.label}：点击添加，或拖到画布指定位置`}
            >
              <span className={cn('flex size-6 shrink-0 items-center justify-center rounded-control', KIND_CHIP_CLASS[kind])}>
                <Icon className="size-3.5" />
              </span>
              <span className="truncate">{meta.label}</span>
            </button>
          );
        })}
      </aside>
      ) : null}

      <div
        className="atb-rf relative min-h-0 flex-1 rounded-card border border-border bg-bg-raised"
        onDragOver={(event) => {
          event.preventDefault();
          event.dataTransfer.dropEffect = 'move';
        }}
        onDrop={onDrop}
      >
        <ReactFlow<SkillFlowNode, SkillFlowEdge>
          nodes={nodes}
          edges={edges}
          nodeTypes={nodeTypes}
          edgeTypes={edgeTypes}
          onNodesChange={onNodesChange}
          onEdgesChange={onEdgeSelections}
          onNodeDragStop={onNodeDragStop}
          onConnect={onConnect}
          isValidConnection={isValidConnection}
          onBeforeDelete={onBeforeDelete}
          onNodesDelete={onNodesDelete}
          onEdgesDelete={onEdgesDelete}
          deleteKeyCode={readOnly ? null : ['Delete', 'Backspace']}
          multiSelectionKeyCode={['Meta', 'Shift']}
          nodesDraggable={!readOnly}
          nodesConnectable={!readOnly}
          snapToGrid
          snapGrid={[8, 8]}
          minZoom={0.2}
          maxZoom={2}
          fitView
          fitViewOptions={{ padding: 0.2 }}
          proOptions={{ hideAttribution: false }}
          elevateEdgesOnSelect
        >
          <Background variant={BackgroundVariant.Dots} gap={24} size={1.5} color="var(--color-border)" />
          <Controls showInteractive={false} position="bottom-right" />
          <MiniMap
            position="bottom-left"
            pannable
            zoomable
            className="!border !border-border !rounded-card overflow-hidden"
            nodeColor={(node) => KIND_MINIMAP_COLOR[(node as SkillFlowNode).data.block.kind]}
            nodeStrokeColor="var(--color-border-strong)"
            maskColor="var(--color-bg-app)"
          />

          {/* 循环引用警示（与发布检查同一套 cyclicBlockIds）。 */}
          {cyclic.size > 0 ? (
            <Panel position="top-center">
              <div className="flex items-center gap-1.5 rounded-badge border border-status-failed/40 bg-status-failed-soft px-3 py-1 text-aux text-status-failed">
                <TriangleAlert className="size-3.5" />
                存在循环引用，发布检查将不通过
              </div>
            </Panel>
          ) : null}

          {!readOnly ? (
          <Panel position="top-left">
            <Button
              variant="default"
              size="sm"
              icon={<LayoutGrid className="size-4" />}
              disabled={blocks.length === 0}
              onClick={autoLayout}
            >
              自动整理
            </Button>
          </Panel>
          ) : null}
        </ReactFlow>

        {blocks.length === 0 ? (
          <div className="pointer-events-none absolute inset-0 flex flex-col items-center justify-center gap-2 text-text-tertiary">
            <Plus className="size-6" />
            <p className="text-body">{readOnly ? '该技能没有流程块' : '从左侧面板添加第一个流程块'}</p>
          </div>
        ) : null}

        {/* 拖放新块时跟随指针的幽灵提示。 */}
        {dropHint ? (
          <div className="pointer-events-none fixed bottom-2 right-2 z-50 flex items-center gap-1.5 rounded-card border border-primary bg-bg-surface px-2 py-1 text-aux text-primary shadow-card">
            {(() => {
              const Icon = BLOCK_KIND_META[dropHint].icon;
              return <Icon className="size-3.5" />;
            })()}
            松开放置「{BLOCK_KIND_META[dropHint].label}」
          </div>
        ) : null}
      </div>

      {/* 双击节点打开的块编辑抽屉（复用 BlockFields，与可视化/结构化模式同表单）。 */}
      <Drawer open={Boolean(editingBlock)} onClose={() => setEditingId(null)} title={editingBlock ? `编辑「${blockTitle(editingBlock, 0)}」` : '编辑块'}>
        {editingBlock ? (
          <div className="flex min-h-0 flex-1 flex-col">
            <div className="atb-scroll flex-1 overflow-y-auto px-5 py-4">
              <div className="flex flex-col gap-4">
                <Field label="块标题" htmlFor="flow-block-title">
                  <Input
                    id="flow-block-title"
                    value={editingBlock.title}
                    placeholder={BLOCK_KIND_META[editingBlock.kind].label}
                    disabled={readOnly}
                    onChange={(event) => patchBlock(editingBlock.id, { title: event.target.value })}
                  />
                </Field>
                <BlockFields
                  block={editingBlock}
                  variableOptions={variableOptions}
                  targetOptions={targetOptions}
                  readOnly={readOnly}
                  onPatch={(patch) => patchBlock(editingBlock.id, patch)}
                />
              </div>
            </div>
            <footer className="flex items-center justify-between border-t border-border px-5 py-3">
              {!readOnly ? (
              <Button variant="ghost" size="sm" icon={<Trash2 className="size-4" />} className="text-status-failed hover:text-status-failed" onClick={() => deleteBlockConfirmed(editingBlock.id)}>
                删除块
              </Button>
              ) : <span />}
              <Button variant="primary" size="sm" onClick={() => setEditingId(null)}>
                完成
              </Button>
            </footer>
          </div>
        ) : null}
      </Drawer>
    </div>
  );
}
