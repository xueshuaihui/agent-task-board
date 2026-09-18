import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
} from 'react';
import { Maximize } from 'lucide-react';
import { cn } from '@/lib/cn';
import type { SkillContent } from './types';
import { BLOCK_KIND_META } from './meta';

/**
 * 流程图视图（2.md 11.2 只读版）：节点=块，边=next 指针。
 *
 * 独立实现的简单画布——分层布局（入口块为第 0 层，BFS 深度定列，同层纵向排列），
 * 滚轮缩放（40%–200%，指针锚点）+ 空白处拖拽平移 + 「适应画布」。不走 canvas 拖线，
 * 连线编辑在可视化模式用 next 下拉完成。
 */

const NODE_WIDTH = 168;
const NODE_HEIGHT = 52;
const COL_GAP = 88;
const ROW_GAP = 28;

const MIN_SCALE = 0.4;
const MAX_SCALE = 2;

interface Transform {
  x: number;
  y: number;
  k: number;
}

const IDENTITY: Transform = { x: 0, y: 0, k: 1 };

interface FlowNode {
  id: string;
  label: string;
  kindLabel: string;
  kindClass: string;
  x: number;
  y: number;
}

interface FlowEdge {
  from: FlowNode;
  to: FlowNode | undefined;
  when: string;
}

export function SkillFlowView({ content, className }: { content: SkillContent; className?: string }) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [transform, setTransform] = useState<Transform>(IDENTITY);
  const [size, setSize] = useState({ width: 0, height: 0 });
  const draggingRef = useRef<{ x: number; y: number; tx: number; ty: number } | null>(null);
  const fittedRef = useRef(false);

  const { nodes, edges, width, height } = useMemo(() => layout(content), [content]);

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

  const fitView = useCallback(() => {
    if (size.width <= 0 || size.height <= 0 || width <= 0) return;
    const k = Math.min(MAX_SCALE, Math.max(MIN_SCALE, Math.min(size.width / width, size.height / height)));
    setTransform({ k, x: (size.width - width * k) / 2, y: (size.height - height * k) / 2 });
  }, [size, width, height]);

  useEffect(() => {
    if (!fittedRef.current && nodes.length > 0 && size.width > 0) {
      fittedRef.current = true;
      fitView();
    }
  }, [nodes.length, size.width, fitView]);

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
        return {
          k,
          x: px - ((px - prev.x) / prev.k) * k,
          y: py - ((py - prev.y) / prev.k) * k,
        };
      });
    };
    element.addEventListener('wheel', onWheel, { passive: false });
    return () => element.removeEventListener('wheel', onWheel);
  }, []);

  if (nodes.length === 0) {
    return (
      <div className={cn('flex items-center justify-center text-aux text-text-tertiary', className)}>
        暂无内容块
      </div>
    );
  }

  return (
    <div className={cn('relative overflow-hidden rounded-card border border-border bg-bg-raised', className)}>
      <div
        ref={containerRef}
        className="h-full w-full cursor-grab active:cursor-grabbing"
        onPointerDown={(event) => {
          draggingRef.current = { x: event.clientX, y: event.clientY, tx: transform.x, ty: transform.y };
          event.currentTarget.setPointerCapture(event.pointerId);
        }}
        onPointerMove={(event: ReactPointerEvent<HTMLDivElement>) => {
          const drag = draggingRef.current;
          if (!drag) return;
          setTransform((prev) => ({ ...prev, x: drag.tx + (event.clientX - drag.x), y: drag.ty + (event.clientY - drag.y) }));
        }}
        onPointerUp={() => {
          draggingRef.current = null;
        }}
      >
        <svg className="h-full w-full" role="img" aria-label="技能流程图">
          <defs>
            <marker id="skill-flow-arrow" markerWidth="8" markerHeight="8" refX="7" refY="4" orient="auto">
              <path d="M0,0 L8,4 L0,8 Z" className="fill-border-strong" />
            </marker>
          </defs>
          <g transform={`translate(${transform.x},${transform.y}) scale(${transform.k})`}>
            {edges.map((edge, index) => (
              <g key={`${edge.from.id}-${index}`}>
                <line
                  x1={edge.from.x + NODE_WIDTH}
                  y1={edge.from.y + NODE_HEIGHT / 2}
                  x2={edge.to ? edge.to.x : edge.from.x + NODE_WIDTH}
                  y2={edge.to ? edge.to.y + NODE_HEIGHT / 2 : edge.from.y + NODE_HEIGHT / 2}
                  className="stroke-border-strong"
                  strokeWidth={1.5}
                  markerEnd="url(#skill-flow-arrow)"
                />
                {edge.when ? (
                  <text
                    x={(edge.from.x + NODE_WIDTH + (edge.to?.x ?? edge.from.x + NODE_WIDTH)) / 2}
                    y={(edge.from.y + (edge.to?.y ?? edge.from.y)) / 2 + NODE_HEIGHT / 2 - 6}
                    className="fill-text-tertiary text-[10px]"
                    textAnchor="middle"
                  >
                    {edge.when}
                  </text>
                ) : null}
              </g>
            ))}
            {nodes.map((node) => (
              <g key={node.id} transform={`translate(${node.x},${node.y})`}>
                <rect
                  width={NODE_WIDTH}
                  height={NODE_HEIGHT}
                  rx={10}
                  className={cn('fill-bg-surface stroke-border', node.id === content.entryBlockId && 'stroke-primary')}
                  strokeWidth={node.id === content.entryBlockId ? 2 : 1}
                />
                <text x={12} y={22} className="fill-text-primary text-[12px] font-medium">
                  {node.label}
                </text>
                <text x={12} y={40} className={cn('text-[10px]', 'fill-text-tertiary')}>
                  {node.kindLabel}
                </text>
              </g>
            ))}
          </g>
        </svg>
      </div>
      <button
        type="button"
        aria-label="适应画布"
        onClick={fitView}
        className="absolute right-2 top-2 flex size-7 items-center justify-center rounded-control border border-border bg-bg-surface text-text-secondary shadow-card hover:text-text-primary"
      >
        <Maximize className="size-4" />
      </button>
    </div>
  );
}

/** 分层布局：从入口 BFS 定列（成环的块退回「未可达」，排在最后一列）。 */
function layout(content: SkillContent): {
  nodes: FlowNode[];
  edges: FlowEdge[];
  width: number;
  height: number;
} {
  const blocks = content.blocks;
  const byId = new Map(blocks.map((block) => [block.id, block]));
  const depth = new Map<string, number>();
  const queue: string[] = [];
  if (content.entryBlockId && byId.has(content.entryBlockId)) {
    depth.set(content.entryBlockId, 0);
    queue.push(content.entryBlockId);
  } else if (blocks.length > 0) {
    depth.set(blocks[0].id, 0);
    queue.push(blocks[0].id);
  }
  for (let head = 0; head < queue.length; head += 1) {
    const current = queue[head];
    const level = depth.get(current) ?? 0;
    for (const next of byId.get(current)?.next ?? []) {
      if (next.to && byId.has(next.to) && !depth.has(next.to)) {
        depth.set(next.to, level + 1);
        queue.push(next.to);
      }
    }
  }
  /* 没被 BFS 到的块（游离/环上）放最后一列。 */
  const orphanDepth = (depth.size ? Math.max(...depth.values()) : 0) + 1;
  for (const block of blocks) {
    if (!depth.has(block.id)) depth.set(block.id, orphanDepth);
  }

  const columns = new Map<number, string[]>();
  for (const block of blocks) {
    const level = depth.get(block.id) ?? 0;
    const column = columns.get(level) ?? [];
    column.push(block.id);
    columns.set(level, column);
  }

  const nodes: FlowNode[] = [];
  for (const [level, ids] of columns) {
    ids.forEach((id, rowIndex) => {
      const block = byId.get(id);
      if (!block) return;
      nodes.push({
        id,
        label: block.title || '未命名块',
        kindLabel: BLOCK_KIND_META[block.kind].label,
        kindClass: BLOCK_KIND_META[block.kind].kindClass,
        x: level * (NODE_WIDTH + COL_GAP),
        y: rowIndex * (NODE_HEIGHT + ROW_GAP),
      });
    });
  }
  const nodeById = new Map(nodes.map((node) => [node.id, node]));
  const edges: FlowEdge[] = [];
  for (const block of blocks) {
    const from = nodeById.get(block.id);
    if (!from) continue;
    const nexts = block.next ?? [];
    if (nexts.length === 0) continue;
    for (const next of nexts) {
      edges.push({ from, to: next.to ? nodeById.get(next.to) : undefined, when: next.when });
    }
  }
  const width = Math.max(1, ((columns.size || 1) - 1) * (NODE_WIDTH + COL_GAP) + NODE_WIDTH);
  const rowCount = Math.max(1, ...[...columns.values()].map((ids) => ids.length));
  const height = rowCount * NODE_HEIGHT + (rowCount - 1) * ROW_GAP;
  return { nodes, edges, width, height };
}
