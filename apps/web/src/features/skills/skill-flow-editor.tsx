import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
} from 'react';
import { Flag, LayoutGrid, Maximize, Plus, Trash2, TriangleAlert } from 'lucide-react';
import { cn } from '@/lib/cn';
import { Button, Drawer, Field, IconButton, Input } from '@/components/ui';
import { BLOCK_KIND_META, blockTitle, createBlock, cyclicBlockIds, inferVariableOptions } from './meta';
import { BlockFields } from './block-fields';
import {
  FLOW_NODE_HEIGHT,
  FLOW_NODE_WIDTH,
  FLOW_ROW_GAP,
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
 * 流程图视图（2.md 11.2 可编辑版）：节点=块（可拖拽定位，坐标写在 block.pos）、
 * 边=next 指针（锚点拖线建立，点选后 Del / × 删除）、双击节点打开块编辑抽屉、
 * 左侧块面板点击/拖拽新增块。滚轮缩放 + 空白拖拽平移 + 自动整理 + 适应画布 +
 * dot grid 背景；cyclicBlockIds 检测到的环上节点与边标红虚线，与发布检查联动。
 *
 * 所有编辑实时写回与其他三种模式共享的同一份 blocks 草稿（onChange），脏态/自动保存
 * 沿用 skill-editor-page 现有机制；pos 是 passthrough JSON 上的附加字段，后端无感知。
 */

const MIN_SCALE = 0.4;
const MAX_SCALE = 2;
const GRID_SIZE = 24;

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

interface Transform {
  x: number;
  y: number;
  k: number;
}

const IDENTITY: Transform = { x: 0, y: 0, k: 1 };

type Selection =
  | { type: 'node'; id: string }
  | { type: 'edge'; fromId: string; branchIndex: number }
  | null;

interface ConnectDraft {
  fromId: string;
  branchIndex: number;
  x: number;
  y: number;
}

interface PlaceDraft {
  kind: SkillBlockKind;
  clientX: number;
  clientY: number;
}

export interface SkillFlowEditorProps {
  content: SkillContent;
  onChange: (next: SkillContent) => void;
  className?: string;
}

export function SkillFlowEditor({ content, onChange, className }: SkillFlowEditorProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [transform, setTransform] = useState<Transform>(IDENTITY);
  const [size, setSize] = useState({ width: 0, height: 0 });
  const fittedRef = useRef(false);

  /* refs 镜像最新值，供 window 指针监听器里读取而不吃陈旧闭包。 */
  const transformRef = useRef(transform);
  transformRef.current = transform;
  const contentRef = useRef(content);
  contentRef.current = content;

  const [selection, setSelection] = useState<Selection>(null);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [livePos, setLivePos] = useState<{ id: string; x: number; y: number } | null>(null);
  const [connectDraft, setConnectDraft] = useState<ConnectDraft | null>(null);
  const [placeDraft, setPlaceDraft] = useState<PlaceDraft | null>(null);

  const blocks = content.blocks;
  const byId = useMemo(() => new Map(blocks.map((block) => [block.id, block])), [blocks]);
  const cyclic = useMemo(() => cyclicBlockIds(content), [content]);
  const edges = useMemo(() => outgoingEdges(content), [content]);

  /* 没写 pos 的块兜底用 BFS 网格坐标展示（ensureBlockPos 回写后即有真实 pos）。 */
  const fallbackPos = useMemo(() => {
    const map = new Map<string, { x: number; y: number }>();
    for (const block of ensureBlockPos(content).blocks) {
      if (block.pos) map.set(block.id, block.pos);
    }
    return map;
  }, [content]);

  const posOf = useCallback(
    (block: SkillBlock): { x: number; y: number } => {
      if (livePos && livePos.id === block.id) return { x: livePos.x, y: livePos.y };
      return block.pos ?? fallbackPos.get(block.id) ?? { x: 0, y: 0 };
    },
    [livePos, fallbackPos],
  );

  /* 进入画布时给缺 pos 的块自动分层落位（写回共享草稿，pos 随自动保存持久化）。 */
  useEffect(() => {
    if (blocks.some((block) => !block.pos)) onChange(ensureBlockPos(contentRef.current));
  }, [blocks, onChange]);

  useEffect(() => {
    const element = containerRef.current;
    if (!element) return;
    const observer = new ResizeObserver((entries) => {
      const rect = entries[0]?.contentRect;
      if (rect) setSize({ width: rect.width, height: rect.height });
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  const boundingBox = useMemo(() => {
    if (blocks.length === 0) return null;
    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    for (const block of blocks) {
      const pos = posOf(block);
      minX = Math.min(minX, pos.x);
      minY = Math.min(minY, pos.y);
      maxX = Math.max(maxX, pos.x + FLOW_NODE_WIDTH);
      maxY = Math.max(maxY, pos.y + FLOW_NODE_HEIGHT);
    }
    return { minX, minY, width: maxX - minX, height: maxY - minY };
  }, [blocks, posOf]);

  const fitView = useCallback(() => {
    const element = containerRef.current;
    if (!element || !boundingBox || size.width <= 0) return;
    const k = Math.min(
      MAX_SCALE,
      Math.max(MIN_SCALE, Math.min(size.width / boundingBox.width, size.height / boundingBox.height)),
    );
    setTransform({
      k,
      x: -boundingBox.minX * k + (size.width - boundingBox.width * k) / 2,
      y: -boundingBox.minY * k + (size.height - boundingBox.height * k) / 2,
    });
  }, [size, boundingBox]);

  useEffect(() => {
    if (!fittedRef.current && blocks.length > 0 && size.width > 0) {
      fittedRef.current = true;
      fitView();
    }
  }, [blocks.length, size.width, fitView]);

  /* React onWheel 是 passive 的，缩放要 preventDefault，手动挂非 passive 监听。 */
  useEffect(() => {
    const element = containerRef.current;
    if (!element) return;
    const onWheel = (event: WheelEvent) => {
      event.preventDefault();
      setTransform((prev) => {
        const factor = event.deltaY < 0 ? 1.1 : 1 / 1.1;
        const k = Math.min(MAX_SCALE, Math.max(MIN_SCALE, prev.k * factor));
        const rect = element.getBoundingClientRect();
        const px = event.clientX - rect.left;
        const py = event.clientY - rect.top;
        return { k, x: px - ((px - prev.x) / prev.k) * k, y: py - ((py - prev.y) / prev.k) * k };
      });
    };
    element.addEventListener('wheel', onWheel, { passive: false });
    return () => element.removeEventListener('wheel', onWheel);
  }, []);

  const clientToCanvas = useCallback((clientX: number, clientY: number) => {
    const element = containerRef.current;
    const t = transformRef.current;
    const rect = element?.getBoundingClientRect();
    return {
      x: rect ? (clientX - rect.left - t.x) / t.k : 0,
      y: rect ? (clientY - rect.top - t.y) / t.k : 0,
    };
  }, []);

  /* 空白处按下：平移；顺带清掉选中（点空白=取消选择）。 */
  const onCanvasPointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) return;
    setSelection(null);
    const start = { x: event.clientX, y: event.clientY, tx: transform.x, ty: transform.y };
    const element = event.currentTarget;
    element.setPointerCapture(event.pointerId);
    const move = (moveEvent: PointerEvent) => {
      setTransform((prev) => ({
        ...prev,
        x: start.tx + (moveEvent.clientX - start.x),
        y: start.ty + (moveEvent.clientY - start.y),
      }));
    };
    const up = () => {
      element.removeEventListener('pointermove', move);
      element.removeEventListener('pointerup', up);
    };
    element.addEventListener('pointermove', move);
    element.addEventListener('pointerup', up);
  };

  /* 节点拖拽：移动期间只更新本地 livePos，松手一次性写回草稿（避免拖拽过程狂触发保存）。 */
  const onNodePointerDown = (event: ReactPointerEvent<HTMLDivElement>, block: SkillBlock) => {
    if (event.button !== 0) return;
    event.stopPropagation();
    setSelection({ type: 'node', id: block.id });
    const startCanvas = clientToCanvas(event.clientX, event.clientY);
    const origin = block.pos ?? fallbackPos.get(block.id) ?? { x: 0, y: 0 };
    const offset = { dx: startCanvas.x - origin.x, dy: startCanvas.y - origin.y };
    const move = (moveEvent: PointerEvent) => {
      const point = clientToCanvas(moveEvent.clientX, moveEvent.clientY);
      setLivePos({ id: block.id, x: point.x - offset.dx, y: point.y - offset.dy });
    };
    const up = (upEvent: PointerEvent) => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      const point = clientToCanvas(upEvent.clientX, upEvent.clientY);
      setLivePos(null);
      onChange(
        commitPos(contentRef.current, block.id, {
          x: point.x - offset.dx,
          y: point.y - offset.dy,
        }),
      );
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  };

  /* 从输出锚点拖线：松手落点命中节点（data-node-id）即建线。 */
  const onAnchorPointerDown = (
    event: ReactPointerEvent<HTMLElement>,
    fromId: string,
    branchIndex: number,
  ) => {
    if (event.button !== 0) return;
    event.stopPropagation();
    const start = clientToCanvas(event.clientX, event.clientY);
    setConnectDraft({ fromId, branchIndex, x: start.x, y: start.y });
    const move = (moveEvent: PointerEvent) => {
      const point = clientToCanvas(moveEvent.clientX, moveEvent.clientY);
      setConnectDraft({ fromId, branchIndex, x: point.x, y: point.y });
    };
    const up = (upEvent: PointerEvent) => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      setConnectDraft(null);
      const hit = document
        .elementFromPoint(upEvent.clientX, upEvent.clientY)
        ?.closest('[data-node-id]');
      const toId = hit?.getAttribute('data-node-id');
      if (toId && toId !== fromId) {
        onChange(setEdgeTarget(contentRef.current, fromId, branchIndex, toId));
      }
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  };

  /* 块面板：点击=加到视口中心附近空位；按住拖到画布=落点放置。 */
  const onPanelItemPointerDown = (event: ReactPointerEvent<HTMLElement>, kind: SkillBlockKind) => {
    if (event.button !== 0) return;
    event.preventDefault();
    const startX = event.clientX;
    const startY = event.clientY;
    let moved = false;
    const move = (moveEvent: PointerEvent) => {
      if (!moved && Math.hypot(moveEvent.clientX - startX, moveEvent.clientY - startY) < 5) return;
      moved = true;
      setPlaceDraft({ kind, clientX: moveEvent.clientX, clientY: moveEvent.clientY });
    };
    const up = (upEvent: PointerEvent) => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      setPlaceDraft(null);
      if (moved) {
        const point = clientToCanvas(upEvent.clientX, upEvent.clientY);
        addBlock(kind, point);
      }
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  };

  const addBlock = useCallback(
    (kind: SkillBlockKind, at?: { x: number; y: number }) => {
      const current = contentRef.current;
      const seed = createBlock(kind, current.blocks.length);
      const jitter = (current.blocks.length % 5) * (FLOW_NODE_HEIGHT + FLOW_ROW_GAP);
      const center = {
        x: size.width / (2 * transformRef.current.k) - transformRef.current.x / transformRef.current.k - FLOW_NODE_WIDTH / 2,
        y: size.height / (2 * transformRef.current.k) - transformRef.current.y / transformRef.current.k - FLOW_NODE_HEIGHT / 2,
      };
      seed.pos = at
        ? { x: Math.round(at.x - FLOW_NODE_WIDTH / 2), y: Math.round(at.y - FLOW_NODE_HEIGHT / 2) }
        : { x: Math.round(center.x + jitter), y: Math.round(center.y + jitter) };
      onChange({
        blocks: [...current.blocks, seed],
        entryBlockId: current.entryBlockId ?? seed.id,
      });
      setSelection({ type: 'node', id: seed.id });
    },
    [onChange, size],
  );

  const patchBlock = useCallback(
    (id: string, patch: Partial<SkillBlock>) => {
      const current = contentRef.current;
      onChange({
        ...current,
        blocks: current.blocks.map((block) => (block.id === id ? { ...block, ...patch } : block)),
      });
    },
    [onChange],
  );

  const deleteBlock = useCallback(
    (id: string) => {
      const block = byId.get(id);
      if (!block) return;
      if (!window.confirm(`删除块「${blockTitle(block, 0)}」？指向它的连线会一并清掉`)) return;
      onChange(removeBlockWithRefs(contentRef.current, id));
      setSelection(null);
      setEditingId((prev) => (prev === id ? null : prev));
    },
    [byId, onChange],
  );

  /* 键盘：Del 删选中（边直接删，节点需确认）；Esc 取消拖线/清选中。输入框内不拦截。 */
  useEffect(() => {
    const handler = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      if (target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.tagName === 'SELECT' || target.isContentEditable)) {
        return;
      }
      if (event.key === 'Escape') {
        setSelection(null);
        return;
      }
      if (event.key !== 'Delete' && event.key !== 'Backspace') return;
      if (!selection) return;
      event.preventDefault();
      if (selection.type === 'edge') {
        onChange(removeEdgeTarget(contentRef.current, selection.fromId, selection.branchIndex));
        setSelection(null);
      } else {
        deleteBlock(selection.id);
      }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [selection, onChange, deleteBlock]);

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
      {/* 左侧块类型面板：15 类，点击添加 / 按住拖到画布落点。 */}
      <aside className="flex w-36 shrink-0 flex-col gap-1 overflow-y-auto rounded-card border border-border bg-bg-raised p-2">
        <p className="px-1 pb-1 text-aux text-text-tertiary">块类型</p>
        {KIND_ORDER.map((kind) => {
          const meta = BLOCK_KIND_META[kind];
          const Icon = meta.icon;
          return (
            <button
              key={kind}
              type="button"
              className="flex cursor-grab items-center gap-2 rounded-control px-2 py-1.5 text-left text-aux text-text-secondary hover:bg-bg-muted hover:text-text-primary active:cursor-grabbing"
              title={`${meta.label}：点击添加，或拖到画布指定位置`}
              onPointerDown={(event) => onPanelItemPointerDown(event, kind)}
            >
              <span className={cn('flex size-6 shrink-0 items-center justify-center rounded-control', KIND_CHIP_CLASS[kind])}>
                <Icon className="size-3.5" />
              </span>
              <span className="truncate">{meta.label}</span>
            </button>
          );
        })}
      </aside>

      <div
        ref={containerRef}
        data-canvas-bg
        className="relative min-h-0 flex-1 overflow-hidden rounded-card border border-border bg-bg-raised"
        style={{
          backgroundImage: 'radial-gradient(circle, var(--color-border) 1px, transparent 1px)',
          backgroundSize: `${GRID_SIZE * transform.k}px ${GRID_SIZE * transform.k}px`,
          backgroundPosition: `${transform.x}px ${transform.y}px`,
        }}
        onPointerDown={onCanvasPointerDown}
      >
        {/* 循环引用警示（与发布检查同一套 cyclicBlockIds）。 */}
        {cyclic.size > 0 ? (
          <div className="absolute left-1/2 top-2 z-10 flex -translate-x-1/2 items-center gap-1.5 rounded-badge border border-status-failed/40 bg-status-failed-soft px-3 py-1 text-aux text-status-failed">
            <TriangleAlert className="size-3.5" />
            存在循环引用，发布检查将不通过
          </div>
        ) : null}

        <div
          className="absolute left-2 top-2 z-10 flex items-center gap-1.5"
          onPointerDown={(event) => event.stopPropagation()}
        >
          <Button
            variant="default"
            size="sm"
            icon={<LayoutGrid className="size-4" />}
            disabled={blocks.length === 0}
            onClick={() => onChange(autoLayoutBlocks(contentRef.current))}
          >
            自动整理
          </Button>
          <Button
            variant="default"
            size="sm"
            icon={<Maximize className="size-4" />}
            disabled={blocks.length === 0}
            onClick={fitView}
          >
            适应画布
          </Button>
        </div>

        {blocks.length === 0 ? (
          <div className="flex h-full flex-col items-center justify-center gap-2 text-text-tertiary">
            <Plus className="size-6" />
            <p className="text-body">从左侧面板添加第一个流程块</p>
          </div>
        ) : null}

        {/* 画布内容层：SVG 画边 + HTML 节点，同一 transform。 */}
        <div
          className="absolute left-0 top-0 h-px w-px"
          style={{ transform: `translate(${transform.x}px,${transform.y}px) scale(${transform.k})`, transformOrigin: '0 0' }}
        >
          <svg className="absolute overflow-visible" width={1} height={1} aria-hidden="true">
            <defs>
              <marker id="flow-editor-arrow" markerWidth="8" markerHeight="8" refX="7" refY="4" orient="auto">
                <path d="M0,0 L8,4 L0,8 Z" className="fill-border-strong" />
              </marker>
              <marker id="flow-editor-arrow-active" markerWidth="8" markerHeight="8" refX="7" refY="4" orient="auto">
                <path d="M0,0 L8,4 L0,8 Z" className="fill-primary" />
              </marker>
            </defs>
            {edges.map((edge) => {
              const fromBlock = byId.get(edge.fromId);
              const toBlock = byId.get(edge.toId);
              if (!fromBlock || !toBlock) return null;
              const anchors = anchorOffsets(fromBlock);
              const from = posOf(fromBlock);
              const to = posOf(toBlock);
              const x1 = from.x + (anchors[edge.branchIndex]?.offset ?? FLOW_NODE_WIDTH / 2);
              const y1 = from.y + FLOW_NODE_HEIGHT + 5;
              const x2 = to.x + FLOW_NODE_WIDTH / 2;
              const y2 = to.y - 6;
              const bend = Math.max(40, Math.abs(y2 - y1) / 2);
              const d = `M ${x1} ${y1} C ${x1} ${y1 + bend}, ${x2} ${y2 - bend}, ${x2} ${y2}`;
              const selectedEdge =
                selection?.type === 'edge' &&
                selection.fromId === edge.fromId &&
                selection.branchIndex === edge.branchIndex;
              const cyclicEdge = cyclic.has(edge.fromId) && cyclic.has(edge.toId);
              const midX = (x1 + x2) / 2;
              const midY = (y1 + y2) / 2;
              return (
                <g key={`${edge.fromId}-${edge.branchIndex}`}>
                  <path
                    d={d}
                    className="stroke-transparent"
                    strokeWidth={14}
                    fill="none"
                    style={{ pointerEvents: 'stroke', cursor: 'pointer' }}
                    onPointerDown={(event) => {
                      event.stopPropagation();
                      setSelection({ type: 'edge', fromId: edge.fromId, branchIndex: edge.branchIndex });
                    }}
                  />
                  <path
                    d={d}
                    fill="none"
                    strokeWidth={selectedEdge ? 2 : 1.5}
                    strokeDasharray={cyclicEdge ? '6 4' : undefined}
                    markerEnd={selectedEdge ? 'url(#flow-editor-arrow-active)' : 'url(#flow-editor-arrow)'}
                    className={cn(
                      'pointer-events-none',
                      selectedEdge ? 'stroke-primary' : cyclicEdge ? 'stroke-status-failed' : 'stroke-border-strong',
                    )}
                  />
                  {edge.when ? (
                    <text x={midX} y={midY - 4} textAnchor="middle" className={cn('pointer-events-none text-[10px]', selectedEdge ? 'fill-primary' : 'fill-text-tertiary')}>
                      {edge.when}
                    </text>
                  ) : null}
                </g>
              );
            })}
            {/* 拖线过程中的临时曲线（跟随指针）。 */}
            {connectDraft
              ? (() => {
                  const fromBlock = byId.get(connectDraft.fromId);
                  if (!fromBlock) return null;
                  const anchors = anchorOffsets(fromBlock);
                  const from = posOf(fromBlock);
                  const x1 = from.x + (anchors[connectDraft.branchIndex]?.offset ?? FLOW_NODE_WIDTH / 2);
                  const y1 = from.y + FLOW_NODE_HEIGHT + 5;
                  const bend = Math.max(40, Math.abs(connectDraft.y - y1) / 2);
                  return (
                    <path
                      d={`M ${x1} ${y1} C ${x1} ${y1 + bend}, ${connectDraft.x} ${connectDraft.y - bend}, ${connectDraft.x} ${connectDraft.y}`}
                      fill="none"
                      strokeWidth={1.5}
                      strokeDasharray="4 3"
                      className="pointer-events-none stroke-primary"
                    />
                  );
                })()
              : null}
          </svg>

          {blocks.map((block) => {
            const meta = BLOCK_KIND_META[block.kind];
            const Icon = meta.icon;
            const pos = posOf(block);
            const anchors = anchorOffsets(block);
            const isEntry = block.id === content.entryBlockId;
            const isCyclic = cyclic.has(block.id);
            const selectedNode = selection?.type === 'node' && selection.id === block.id;
            return (
              <div
                key={block.id}
                data-node-id={block.id}
                className="group absolute select-none"
                style={{ left: pos.x, top: pos.y, width: FLOW_NODE_WIDTH, height: FLOW_NODE_HEIGHT }}
                onPointerDown={(event) => onNodePointerDown(event, block)}
                onDoubleClick={() => setEditingId(block.id)}
              >
                <div
                  className={cn(
                    'flex h-full cursor-grab items-center gap-2 rounded-[10px] border bg-bg-surface px-2.5 shadow-card active:cursor-grabbing',
                    isEntry ? 'border-primary' : 'border-border',
                    isCyclic && 'border-dashed border-status-failed',
                    selectedNode && 'ring-2 ring-primary ring-offset-1 ring-offset-bg-raised',
                  )}
                >
                  <span className={cn('flex size-7 shrink-0 items-center justify-center rounded-control', KIND_CHIP_CLASS[block.kind])}>
                    <Icon className="size-4" />
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-caption text-text-primary">{blockTitle(block, 0)}</span>
                    <span className="block truncate text-[10px] text-text-tertiary">{meta.label}</span>
                  </span>
                  <span className="flex shrink-0 items-center gap-0.5 opacity-0 transition-opacity group-hover:opacity-100">
                    <IconButton
                      label="设为入口"
                      variant="ghost"
                      size="icon"
                      className="size-6"
                      disabled={isEntry}
                      onPointerDown={(event) => event.stopPropagation()}
                      onClick={() => onChange(setEntryBlock(contentRef.current, block.id))}
                      icon={<Flag className="size-3.5" />}
                    />
                    <IconButton
                      label="删除块"
                      variant="ghost"
                      size="icon"
                      className="size-6 hover:text-status-failed"
                      onPointerDown={(event) => event.stopPropagation()}
                      onClick={() => deleteBlock(block.id)}
                      icon={<Trash2 className="size-3.5" />}
                    />
                  </span>
                </div>
                {isEntry ? (
                  <span className="absolute -top-2 left-2 rounded-badge bg-primary px-1.5 py-px text-[9px] text-white">
                    入口
                  </span>
                ) : null}
                {/* 输出锚点：单分支底部居中，多分支沿底边均布并标注分支条件。 */}
                {anchors.map((anchor) => (
                  <span key={anchor.branchIndex} className="absolute" style={{ left: anchor.offset - 11, bottom: -12, width: 22 }}>
                    <span
                      data-anchor
                      title="拖到目标节点建立连线"
                      className="mx-auto block size-2.5 cursor-crosshair rounded-full border border-border-strong bg-bg-surface hover:scale-125 hover:border-primary hover:bg-primary-light"
                      onPointerDown={(event) => onAnchorPointerDown(event, block.id, anchor.branchIndex)}
                    />
                    {anchor.label ? (
                      <span className="mt-0.5 block text-center text-[9px] leading-none text-text-tertiary">{anchor.label}</span>
                    ) : null}
                  </span>
                ))}
              </div>
            );
          })}

          {/* 选中边中点上的删线按钮（画布坐标系）。 */}
          {selection?.type === 'edge'
            ? (() => {
                const edge = edges.find(
                  (item) => item.fromId === selection.fromId && item.branchIndex === selection.branchIndex,
                );
                const fromBlock = edge ? byId.get(edge.fromId) : undefined;
                const toBlock = edge ? byId.get(edge.toId) : undefined;
                if (!edge || !fromBlock || !toBlock) return null;
                const anchors = anchorOffsets(fromBlock);
                const from = posOf(fromBlock);
                const to = posOf(toBlock);
                const midX = (from.x + (anchors[edge.branchIndex]?.offset ?? FLOW_NODE_WIDTH / 2) + to.x + FLOW_NODE_WIDTH / 2) / 2;
                const midY = (from.y + FLOW_NODE_HEIGHT + to.y) / 2;
                return (
                  <button
                    type="button"
                    aria-label="删除连线"
                    title="删除连线"
                    className="absolute z-10 flex size-4.5 items-center justify-center rounded-full border border-border bg-bg-surface text-text-tertiary hover:border-status-failed hover:text-status-failed"
                    style={{ left: midX - 9, top: midY - 20 }}
                    onPointerDown={(event) => event.stopPropagation()}
                    onClick={() => {
                      onChange(removeEdgeTarget(contentRef.current, edge.fromId, edge.branchIndex));
                      setSelection(null);
                    }}
                  >
                    <Trash2 className="size-2.5" />
                  </button>
                );
              })()
            : null}
        </div>

        {/* 拖放新块时跟随指针的幽灵提示。 */}
        {placeDraft ? (
          <div
            className="pointer-events-none fixed z-50 flex items-center gap-1.5 rounded-card border border-primary bg-bg-surface px-2 py-1 text-aux text-primary shadow-card"
            style={{ left: placeDraft.clientX + 10, top: placeDraft.clientY + 10 }}
          >
            {(() => {
              const Icon = BLOCK_KIND_META[placeDraft.kind].icon;
              return <Icon className="size-3.5" />;
            })()}
            {BLOCK_KIND_META[placeDraft.kind].label}
          </div>
        ) : null}
      </div>

      {/* 双击节点打开的块编辑抽屉（复用 BlockFields，与可视化/结构化模式同表单）。 */}
      <Drawer open={Boolean(editingBlock)} onClose={() => setEditingId(null)} title={editingBlock ? `编辑「${blockTitle(editingBlock, 0)}」` : '编辑块'}>
        {editingBlock ? (
          <div className="flex min-h-0 flex-1 flex-col">
            <div className="flex-1 overflow-y-auto px-5 py-4">
              <div className="flex flex-col gap-4">
                <Field label="块标题" htmlFor="flow-block-title">
                  <Input
                    id="flow-block-title"
                    value={editingBlock.title}
                    placeholder={BLOCK_KIND_META[editingBlock.kind].label}
                    onChange={(event) => patchBlock(editingBlock.id, { title: event.target.value })}
                  />
                </Field>
                <BlockFields
                  block={editingBlock}
                  variableOptions={variableOptions}
                  targetOptions={targetOptions}
                  onPatch={(patch) => patchBlock(editingBlock.id, patch)}
                />
              </div>
            </div>
            <footer className="flex items-center justify-between border-t border-border px-5 py-3">
              <Button variant="ghost" size="sm" icon={<Trash2 className="size-4" />} className="text-status-failed hover:text-status-failed" onClick={() => deleteBlock(editingBlock.id)}>
                删除块
              </Button>
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

/** 提交节点拖拽后的位置（只动目标块的 pos，其余字段原样保留）。 */
function commitPos(content: SkillContent, id: string, pos: { x: number; y: number }): SkillContent {
  return {
    ...content,
    blocks: content.blocks.map((block) =>
      block.id === id ? { ...block, pos: { x: Math.round(pos.x), y: Math.round(pos.y) } } : block,
    ),
  };
}

/**
 * 节点的输出锚点：单分支（或无 next）一个，底部居中；
 * 多分支（decision 等）沿底边均布，标注 next[i].when。
 */
function anchorOffsets(block: SkillBlock): { branchIndex: number; offset: number; label: string }[] {
  const nexts = block.next ?? [];
  if (nexts.length <= 1) {
    return [{ branchIndex: 0, offset: FLOW_NODE_WIDTH / 2, label: '' }];
  }
  return nexts.map((next, branchIndex) => ({
    branchIndex,
    offset: (FLOW_NODE_WIDTH * (branchIndex + 1)) / (nexts.length + 1),
    label: next.when,
  }));
}
