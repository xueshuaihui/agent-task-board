import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
} from 'react';
import { Maximize, ZoomIn, ZoomOut } from 'lucide-react';
import { cn } from '@/lib/cn';
import { statusLabel } from '@/lib/labels';
import type { GraphEdgeInput, GraphTask, LayoutEdge, LayoutNode } from './layout';
import {
  computeDependencyLayout,
  NODE_HEIGHT,
  NODE_WIDTH,
} from './layout';

/**
 * 依赖图 SVG 画布（2.md 8.1–8.4）：手绘分层布局，不引第三方图库。
 *
 * 交互（8.4）：
 * - 滚轮缩放（50%–200%，以指针为锚点）、按住画布空白处拖拽平移；
 * - 「适应屏幕」自动缩放居中（数据首次到位时也会自动 fit 一次）；
 * - 点击节点 → `onNodeClick`（任务详情抽屉的接缝，由调用方接线）；
 * - 点击边 → `onEdgeClick`（删除确认也在调用方，本组件只发事件）。
 *
 * 颜色一律走 @theme token（fill-/stroke- 工具类），不硬编码 hex。
 */

const MIN_SCALE = 0.5;
const MAX_SCALE = 2;

interface Transform {
  x: number;
  y: number;
  k: number;
}

const IDENTITY: Transform = { x: 0, y: 0, k: 1 };

/** 状态色 token → SVG fill 类（与 lib/status-style.ts 同一套 token，缺表外兜底）。 */
const NODE_FILL: Record<string, { main: string; soft: string }> = {
  BACKLOG: { main: 'fill-status-backlog', soft: 'fill-status-backlog-soft' },
  READY: { main: 'fill-status-ready', soft: 'fill-status-ready-soft' },
  RUNNING: { main: 'fill-status-running', soft: 'fill-status-running-soft' },
  REVIEW: { main: 'fill-status-review', soft: 'fill-status-review-soft' },
  DONE: { main: 'fill-status-done', soft: 'fill-status-done-soft' },
  FAILED: { main: 'fill-status-failed', soft: 'fill-status-failed-soft' },
};
const NODE_FILL_FALLBACK = { main: 'fill-status-blocked', soft: 'fill-status-blocked-soft' };

const PRIORITY_FILL: Record<number, string> = {
  0: 'fill-priority-0',
  1: 'fill-priority-1',
  2: 'fill-priority-2',
  3: 'fill-priority-3',
};

export interface DependencyGraphCanvasProps {
  tasks: readonly GraphTask[];
  edges: readonly GraphEdgeInput[];
  onNodeClick?: (taskId: string) => void;
  onEdgeClick?: (edge: LayoutEdge) => void;
  className?: string;
}

export function DependencyGraphCanvas({
  tasks,
  edges,
  onNodeClick,
  onEdgeClick,
  className,
}: DependencyGraphCanvasProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [transform, setTransform] = useState<Transform>(IDENTITY);
  const [size, setSize] = useState({ width: 0, height: 0 });
  const fittedRef = useRef(false);
  const layout = useMemo(() => computeDependencyLayout(tasks, edges), [tasks, edges]);
  const nodeById = useMemo(
    () => new Map(layout.nodes.map((node) => [node.id, node])),
    [layout.nodes],
  );

  /* 容器尺寸跟踪（适应屏幕要用）。 */
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
    const { width, height } = size;
    if (width <= 0 || height <= 0 || layout.width <= 0 || layout.height <= 0) return;
    const k = Math.min(MAX_SCALE, Math.max(MIN_SCALE, Math.min(width / layout.width, height / layout.height)));
    setTransform({
      k,
      x: (width - layout.width * k) / 2,
      y: (height - layout.height * k) / 2,
    });
  }, [size, layout.width, layout.height]);

  /* 数据首次到位自动适应一次；之后尊重用户的缩放/平移。 */
  useEffect(() => {
    if (!fittedRef.current && layout.nodes.length > 0 && size.width > 0) {
      fittedRef.current = true;
      fitView();
    }
  }, [layout.nodes.length, size.width, fitView]);

  /* React 的 onWheel 是 passive 的，缩放要 preventDefault，只能手动挂监听。 */
  useEffect(() => {
    const element = containerRef.current;
    if (!element) return;
    const onWheel = (event: WheelEvent) => {
      event.preventDefault();
      setTransform((current) => {
        const factor = Math.exp(-event.deltaY * 0.0015);
        const k = Math.min(MAX_SCALE, Math.max(MIN_SCALE, current.k * factor));
        const rect = element.getBoundingClientRect();
        const px = event.clientX - rect.left;
        const py = event.clientY - rect.top;
        // 以指针为锚点：指针下的图坐标缩放前后保持不动。
        const gx = (px - current.x) / current.k;
        const gy = (py - current.y) / current.k;
        return { k, x: px - gx * k, y: py - gy * k };
      });
    };
    element.addEventListener('wheel', onWheel, { passive: false });
    return () => element.removeEventListener('wheel', onWheel);
  }, []);

  /* 拖拽平移：按下背景后指针捕获，move 直接改位移。 */
  const panRef = useRef<{ px: number; py: number; x: number; y: number } | null>(null);
  const onPointerDown = (event: ReactPointerEvent<SVGSVGElement>) => {
    if ((event.target as Element).getAttribute('data-pan') !== 'bg') return;
    panRef.current = { px: event.clientX, py: event.clientY, x: transform.x, y: transform.y };
    event.currentTarget.setPointerCapture(event.pointerId);
  };
  const onPointerMove = (event: ReactPointerEvent<SVGSVGElement>) => {
    const pan = panRef.current;
    if (!pan) return;
    setTransform((current) => ({ ...current, x: pan.x + (event.clientX - pan.px), y: pan.y + (event.clientY - pan.py) }));
  };
  const onPointerUp = (event: ReactPointerEvent<SVGSVGElement>) => {
    panRef.current = null;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
  };

  const zoomBy = (factor: number) => {
    setTransform((current) => {
      const k = Math.min(MAX_SCALE, Math.max(MIN_SCALE, current.k * factor));
      const cx = size.width / 2;
      const cy = size.height / 2;
      const gx = (cx - current.x) / current.k;
      const gy = (cy - current.y) / current.k;
      return { k, x: cx - gx * k, y: cy - gy * k };
    });
  };

  return (
    <div ref={containerRef} className={cn('relative h-full min-h-80 w-full overflow-hidden rounded-card bg-bg-raised', className)}>
      <svg
        className="h-full w-full touch-none select-none"
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerUp}
        role="img"
        aria-label="任务依赖图"
      >
        <defs>
          <marker id="dep-arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse" markerUnits="userSpaceOnUse">
            <path d="M 0 1 L 9 5 L 0 9 z" className="fill-border-strong" />
          </marker>
          <marker id="dep-arrow-cycle" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse" markerUnits="userSpaceOnUse">
            <path d="M 0 1 L 9 5 L 0 9 z" className="fill-status-failed" />
          </marker>
        </defs>

        {/* 背景承接平移拖拽 */}
        <rect data-pan="bg" className="fill-transparent" x={0} y={0} width="100%" height="100%" />

        {layout.nodes.length === 0 ? (
          <text
            x="50%"
            y="50%"
            textAnchor="middle"
            dominantBaseline="middle"
            className="fill-text-tertiary text-[13px]"
          >
            暂无任务可绘制依赖图
          </text>
        ) : (
          <g transform={`translate(${transform.x},${transform.y}) scale(${transform.k})`}>
            {layout.edges.map((edge) => (
              <GraphEdgeView key={edge.depId} edge={edge} nodeById={nodeById} onClick={onEdgeClick} />
            ))}
            {layout.nodes.map((node) => (
              <GraphNodeView key={node.id} node={node} onClick={onNodeClick} />
            ))}
          </g>
        )}
      </svg>

      {/* 右上角缩放控制 */}
      <div className="absolute right-3 top-3 flex items-center gap-1 rounded-card border border-border bg-bg-surface p-1 shadow-sm">
        <CanvasButton label="缩小" onClick={() => zoomBy(1 / 1.2)}>
          <ZoomOut className="size-4" aria-hidden />
        </CanvasButton>
        <span className="w-12 text-center text-aux tabular-nums text-text-secondary">
          {Math.round(transform.k * 100)}%
        </span>
        <CanvasButton label="放大" onClick={() => zoomBy(1.2)}>
          <ZoomIn className="size-4" aria-hidden />
        </CanvasButton>
        <CanvasButton label="适应屏幕" onClick={fitView}>
          <Maximize className="size-4" aria-hidden />
        </CanvasButton>
      </div>
    </div>
  );
}

function CanvasButton({
  label,
  onClick,
  children,
}: {
  label: string;
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      title={label}
      aria-label={label}
      onClick={onClick}
      className="inline-flex size-7 items-center justify-center rounded-control text-text-secondary transition-colors hover:bg-bg-muted hover:text-text-primary"
    >
      {children}
    </button>
  );
}

function GraphNodeView({
  node,
  onClick,
}: {
  node: LayoutNode;
  onClick?: (taskId: string) => void;
}) {
  const fill = NODE_FILL[node.status] ?? NODE_FILL_FALLBACK;
  const priorityFill = PRIORITY_FILL[node.priority] ?? PRIORITY_FILL[3];
  const title = node.title.length > 10 ? `${node.title.slice(0, 10)}…` : node.title;

  return (
    <g
      transform={`translate(${node.x},${node.y})`}
      className="cursor-pointer"
      onClick={(event) => {
        event.stopPropagation();
        onClick?.(node.id);
      }}
    >
      <title>{`${node.id} ${node.title}`}</title>
      {/* 卡片主体 */}
      <rect
        width={NODE_WIDTH}
        height={NODE_HEIGHT}
        rx={8}
        className="fill-bg-surface stroke-border"
        strokeWidth={1}
      />
      {/* 左侧状态色条 */}
      <rect width={3} height={NODE_HEIGHT} rx={1.5} className={fill.main} />
      {/* 编号 + 优先级 */}
      <text x={12} y={19} className="fill-text-tertiary font-mono text-[11px] font-medium">
        {node.id}
      </text>
      <circle cx={NODE_WIDTH - 26} cy={15} r={8} className={priorityFill} opacity={0.12} />
      <text
        x={NODE_WIDTH - 26}
        y={19}
        textAnchor="middle"
        className={cn('text-[9px] font-semibold', priorityFill)}
      >
        {`P${node.priority}`}
      </text>
      {/* 标题 */}
      <text x={12} y={41} className="fill-text-primary text-[13px] font-medium">
        {title}
      </text>
      {/* 状态点 + 状态名 + 进度 */}
      <circle cx={16} cy={56} r={4} className={fill.main} />
      <text x={25} y={60} className="fill-text-secondary text-[11px]">
        {statusLabel(node.status)}
      </text>
      {node.progress !== null ? (
        <>
          <rect
            x={NODE_WIDTH - 62}
            y={52}
            width={50}
            height={5}
            rx={2.5}
            className={fill.soft}
          />
          <rect
            x={NODE_WIDTH - 62}
            y={52}
            width={Math.max(2, (50 * Math.min(100, node.progress)) / 100)}
            height={5}
            rx={2.5}
            className={fill.main}
          />
        </>
      ) : null}
      {/* 环上节点标记 */}
      {node.inCycle ? (
        <text x={NODE_WIDTH - 12} y={60} textAnchor="end" className="fill-status-failed text-[10px]">
          环
        </text>
      ) : null}
    </g>
  );
}

function GraphEdgeView({
  edge,
  nodeById,
  onClick,
}: {
  edge: LayoutEdge;
  nodeById: Map<string, LayoutNode>;
  onClick?: (edge: LayoutEdge) => void;
}) {
  const from = nodeById.get(edge.from);
  const to = nodeById.get(edge.to);
  if (!from || !to) return null;

  const d = edgePath(from, to, edge.cycle);
  const strokeClass = edge.cycle ? 'stroke-status-failed' : 'stroke-border-strong';
  const dash = edge.type === 'relates' || edge.cycle ? '5 4' : undefined;
  const marker = edge.cycle ? 'url(#dep-arrow-cycle)' : 'url(#dep-arrow)';

  return (
    <g>
      <path
        d={d}
        fill="none"
        strokeWidth={1.5}
        strokeDasharray={dash}
        markerEnd={marker}
        className={strokeClass}
      />
      {/* 16px 透明命中区：细线难点中（8.4 边点击删除依赖） */}
      <path
        d={d}
        fill="none"
        stroke="transparent"
        strokeWidth={16}
        className="cursor-pointer"
        onClick={(event) => {
          event.stopPropagation();
          onClick?.(edge);
        }}
      >
        <title>{`${edge.type === 'relates' ? '关联' : '阻塞'}依赖：${edge.from} → ${edge.to}（点击删除）`}</title>
      </path>
    </g>
  );
}

/**
 * 边的贝塞尔路径：跨层走「源底部 → 目标顶部」的竖向 S 曲线；
 * 同层 / 向上（环兜底）走「源右侧 → 目标左侧」的横向曲线。
 */
function edgePath(from: LayoutNode, to: LayoutNode, cycle: boolean): string {
  const downward = to.y > from.y + NODE_HEIGHT / 2;
  if (downward && !cycle) {
    const x1 = from.x + NODE_WIDTH / 2;
    const y1 = from.y + NODE_HEIGHT;
    const x2 = to.x + NODE_WIDTH / 2;
    const y2 = to.y;
    const bend = Math.max(24, (y2 - y1) / 2);
    return `M ${x1} ${y1} C ${x1} ${y1 + bend}, ${x2} ${y2 - bend}, ${x2} ${y2}`;
  }
  const [left, right] = from.x <= to.x ? [from, to] : [to, from];
  const x1 = left.x + NODE_WIDTH;
  const y1 = left.y + NODE_HEIGHT / 2;
  const x2 = right.x;
  const y2 = right.y + NODE_HEIGHT / 2;
  const bend = Math.max(24, Math.abs(x2 - x1) / 2);
  return `M ${x1} ${y1} C ${x1 + bend} ${y1}, ${x2 - bend} ${y2}, ${x2} ${y2}`;
}
