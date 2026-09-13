import { useCallback, useEffect, useRef, type KeyboardEvent } from 'react';
import { useDraggable } from '@dnd-kit/core';
import { CSS } from '@dnd-kit/utilities';
import type { FieldDef, TaskCard } from '@/api/types';
import { knownStatus, neighbourColumn, nextLegalColumn } from './model';
import { BoardCardView } from './task-card-view';
import type { CardActions } from './card-actions';
import type { RunOverlay } from './use-run-overlay';

export interface DraggableCardProps {
  card: TaskCard;
  defs: readonly FieldDef[];
  overlay: RunOverlay;
  actions: CardActions;
  /** 卡片被拖起时上报，用来在列底/原位置切换占位样式。 */
  onDraggingChange: (id: string, dragging: boolean) => void;
}

/** 最后一次由键盘驱动换列的卡片：只有它需要在重挂后把焦点要回来（见下面的 effect）。 */
let lastKeyCard: string | null = null;

/**
 * 卡片的拖拽外壳（`useDraggable` 而非 sortable：4.1 + 原型 3.2 规定列内顺序由服务端
 * 按 5.6 抓取顺序固定，前端不提供列内重排，否则卡片位置和 Agent 实际领取顺序对不上）。
 *
 * 键盘可达走同一条落点判定（PRD 7.2）：`←`/`→` 换合法目标列、`⌘/Ctrl + P` 置顶，
 * `Space`/`Enter` 打开详情在 `task-card-view.tsx` 的 article 上（那里也是焦点站）。
 * 这里刻意**不**用 dnd-kit 的 KeyboardSensor——它的激活键是 Space/Enter，会和
 * 「Space 打开详情抽屉」抢同一个按键；而键盘换列本来就是「一次判定 + 一次请求」，
 * 不需要真的把卡片拖起来。
 */
export function DraggableCard({ card, defs, overlay, actions, onDraggingChange }: DraggableCardProps) {
  const {
    listeners,
    setNodeRef: setDraggableNodeRef,
    transform,
    isDragging,
  } = useDraggable({
    id: card.id,
    data: { status: card.status, id: card.id },
  });
  const nodeRef = useRef<HTMLDivElement | null>(null);
  const setNodeRef = useCallback(
    (node: HTMLDivElement | null) => {
      nodeRef.current = node;
      setDraggableNodeRef(node);
    },
    [setDraggableNodeRef],
  );

  useEffect(() => {
    onDraggingChange(card.id, isDragging);
  }, [card.id, isDragging, onDraggingChange]);

  // 换列 = 卡片挂到另一列的 DOM 子树下，浏览器把焦点丢回 body：按一次箭头就得重新 Tab 一轮，
  // 7.2 的「卡片聚焦后 ←/→ 移动」就成了空话。重挂后把焦点还给同一张卡；
  // 焦点已有别的归属（抽屉、菜单、输入框）时一律不抢。
  useEffect(() => {
    if (lastKeyCard !== card.id) return;
    const active = document.activeElement;
    if (active && active !== document.body) return;
    nodeRef.current?.querySelector<HTMLElement>('[data-card-key]')?.focus();
  }, [card.id, card.status]);

  return (
    // 只挂 listeners、不挂 `attributes`：内层 article 已经是 role=button + tabIndex=0，
    // 外层再来一个就是两个焦点站 + 嵌套按钮。
    <div
      ref={setNodeRef}
      style={{ transform: CSS.Translate.toString(transform) }}
      {...listeners}
      onKeyDown={(event) => cardShortcuts(event, card, actions)}
    >
      <BoardCardView card={card} defs={defs} overlay={overlay} actions={actions} dragging={isDragging} />
    </div>
  );
}

/** PRD 7.2 的键盘入口汇总（`Space` 打开详情在 `task-card-view.tsx`）。 */
function cardShortcuts(event: KeyboardEvent<HTMLDivElement>, card: TaskCard, actions: CardActions): void {
  if (isPinChord(event)) {
    event.preventDefault();
    event.stopPropagation();
    // 置顶不改状态、不换列（4.3）：article 原地复用，焦点不需要交接，所以不进 `lastKeyCard`。
    actions.togglePin(card);
    return;
  }
  stepColumn(event, card, actions);
}

/** `⌘/Ctrl + P`：判法与 `desktop.ts` 的 `⌘/Ctrl + R`、快速新建的 `⌘/Ctrl + Enter` 一致。 */
function isPinChord(event: KeyboardEvent): boolean {
  return (event.metaKey || event.ctrlKey) && !event.altKey && event.key.toLowerCase() === 'p';
}

/**
 * `←`/`→` 换列：只落在 4.5 判定合法（✅ 或 🔒）的列上，❌ 列整列跳过（PRD 7.2「在合法目标列间移动」），
 * 挑哪一列在 `model.ts` 的 `nextLegalColumn`，判定与请求都在 `actions.move`（矩阵是唯一依据）。
 * 该方向没有合法列时，把相邻列交给同一个 `actions.move`——它必然判成 ❌，只 Toast 4.5 的文案。
 */
function stepColumn(event: KeyboardEvent<HTMLDivElement>, card: TaskCard, actions: CardActions): void {
  if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return;
  // `Alt + ←/→` 是窗口后退（`desktop.ts` 已拦），带修饰键的箭头不当流转用。
  if (event.altKey || event.metaKey || event.ctrlKey) return;
  if (!knownStatus(card.status)) return; // 20.2 表外状态：不给任何写入口，也不吞按键

  const step: 1 | -1 = event.key === 'ArrowRight' ? 1 : -1;
  const to = nextLegalColumn(card.status, step);
  event.preventDefault();
  event.stopPropagation();
  if (!to) {
    const neighbour = neighbourColumn(card.status, step);
    if (neighbour) actions.move(card, neighbour);
    return;
  }
  lastKeyCard = card.id;
  actions.move(card, to);
}
