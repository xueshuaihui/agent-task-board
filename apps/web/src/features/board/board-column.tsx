import { useDroppable } from '@dnd-kit/core';
import { AnimatePresence, motion, useReducedMotion } from 'motion/react';
import { ChevronRight, ClipboardList, Plus } from 'lucide-react';
import type { BoardColumn, FieldDef } from '@/api/types';
import { navigate } from '@/app/router';
import { taskListSearch } from '@/app/store/filters';
import { itemVariants, listVariants, springs } from '@/lib/motion';
import { statusLabel } from '@/lib/labels';
import { statusStyle, type StatusStyle } from '@/lib/status-style';
import { cn } from '@/lib/cn';
import { Button, CardSkeleton, StatusDot, Tooltip } from '@/components/ui';
import { DraggableCard } from './board-card';
import { boardCardLayoutId, flyRole } from './fly-motion';
import type { CardActions } from './card-actions';
import type { RunOverlay } from './use-run-overlay';
import { groupRunningByToken, showsSeeAll } from './model';
import type { Verdict } from './matrix';

export interface BoardColumnViewProps {
  column: BoardColumn;
  defs: readonly FieldDef[];
  actions: CardActions;
  overlayOf: (id: string) => RunOverlay;
  /** 拖拽开始时按卡片状态算出的该列落点态；空闲时为 null（PRD 7.2 首条）。 */
  dropState: Verdict | null;
  isOver: boolean;
  loading: boolean;
  onDraggingChange: (id: string, dragging: boolean) => void;
}

/**
 * 3.1/3.2 一列：44px 列头固定 + 列内纵向滚动 + 列底常驻入口。
 * 列宽（B7 定弹性等分、G-5 收口）：`min-w-[180px] flex-1` 等分铺满容器、最小 180px 兜底，
 * 窗口变窄放不下时由 `ColumnRow` 的 `overflow-x-auto` 横向滚动。**列宽与筛选结果无关**
 * （2026-09-24 用户拍板覆盖 PRD v1.5 §4.1 的「空列折叠为 40px 竖条」）：七列在任何视图下
 * 恒常驻、恒等分，空列照常渲染 `ColumnEmpty`「暂无任务」，故此处不再有 width 过渡对象。
 */
export function BoardColumnView({
  column,
  defs,
  actions,
  overlayOf,
  dropState,
  isOver,
  loading,
  onDraggingChange,
}: BoardColumnViewProps) {
  const { setNodeRef } = useDroppable({ id: `column:${column.status}`, data: { status: column.status } });
  const style = statusStyle(column.status);
  const reduce = useReducedMotion();
  const dropActive = dropState !== null && dropState.kind !== 'self';
  const forbidden = dropState?.kind === 'forbidden';
  const needsForm = dropState?.kind === 'form';
  const direct = dropState?.kind === 'direct';
  const formAction = dropState?.kind === 'form' ? dropState.action : undefined;
  const highlighted = (direct && isOver) || needsForm;

  return (
    <section
      ref={setNodeRef}
      aria-label={statusLabel(column.status)}
      className={cn(
        'relative flex h-full min-h-0 min-w-[180px] flex-1 flex-col rounded-card',
        dropActive ? 'border-2 border-dashed' : 'border-2 border-transparent',
        dropActive && forbidden && 'border-solid border-status-failed bg-status-failed-soft',
        dropActive && highlighted && 'border-primary bg-primary-light',
      )}
    >
      {dropActive && direct && isOver ? (
        // 3.7：✅ 落点的目标列顶部 2px 主色条。
        <span aria-hidden className="absolute inset-x-0 top-0 h-0.5 rounded-t-card bg-primary" />
      ) : null}

      <ColumnHeader column={column} style={style} formAction={dropActive ? formAction : undefined} />

      {column.status === 'RUNNING' && column.tasks.length > 0 ? (
        <TokenGrouping tasks={column.tasks} />
      ) : null}

      {/* §5.2：列内容器纵向滚动是换列飞行的测量错位来源（回落规则 2），挂 motion 的
          layoutScroll 让投影在滚动后重测位置。 */}
      <motion.div
        layoutScroll
        className={cn(
          'atb-scroll flex min-h-0 flex-1 flex-col gap-2 overflow-y-auto px-4 pb-2',
          forbidden && 'cursor-not-allowed',
        )}
      >
        {loading && column.tasks.length === 0 ? <CardSkeleton count={2} /> : null}
        {/* §4 看板：列内卡片 stagger 入场（≤40ms）+ AnimatePresence 退场；列内顺序仍由服务端定 */}
        <motion.div
          className="flex flex-col gap-2"
          variants={listVariants}
          initial={reduce ? false : 'hidden'}
          animate="show"
        >
          <AnimatePresence>
            {column.tasks.map((card, index) => {
              // §5.2 方案 A 的触发面只有「用户发起的换列」（见 fly-motion.ts 头注）：
              // source = 仍停在来源列的飞行源（挂 layoutId、撤 exit，等快照到达瞬时让位）；
              // target = 快照落地后目标列里的新挂载点（挂 layoutId、不播入场淡入，位置由飞行承担）。
              // null = 其余一切场合（含 WS 换列、规则 3/4/5 命中），逐字节等于现状（方案 B）。
              const role = flyRole(card.id, card.status, reduce === true);
              if (role === 'target') {
                return (
                  <motion.div
                    key={card.id}
                    layoutId={boardCardLayoutId(card.id)}
                    initial={false}
                    transition={springs.gentle}
                    // exit 兜底：TTL 内该卡又从目标列离开且未拿到新一轮 source 标记时
                    // （快照把它移去第三列）按方案 B 常规淡出，不能瞬时消失。
                    exit={{ opacity: 0, y: 8, transition: { duration: 0.14, ease: 'easeOut' } }}
                  >
                    <DraggableCard
                      card={card}
                      defs={defs}
                      actions={actions}
                      overlay={overlayOf(card.id)}
                      onDraggingChange={onDraggingChange}
                    />
                  </motion.div>
                );
              }
              return (
                <motion.div
                  key={card.id}
                  variants={itemVariants}
                  // 显式 initial/animate + custom 索引延迟：数据晚到的卡（WS 推送、
                  // 拖拽回列）不依赖父容器 stagger 编排，否则会卡在 hidden 态不可见。
                  initial={reduce ? false : 'hidden'}
                  animate={reduce ? undefined : 'show'}
                  custom={index}
                  layoutId={role === 'source' ? boardCardLayoutId(card.id) : undefined}
                  transition={role === 'source' ? springs.gentle : undefined}
                  // source 撤 exit：旧列必须与新列挂载同帧瞬时卸载，飞行体才能接管；
                  // 若让它播 140ms 淡出就与飞出的卡构成同 id 双画面（§5.2 禁止）。
                  exit={
                    role === 'source' || reduce
                      ? undefined
                      : { opacity: 0, y: 8, transition: { duration: 0.14, ease: 'easeOut' } }
                  }
                >
                  <DraggableCard
                    card={card}
                    defs={defs}
                    actions={actions}
                    overlay={overlayOf(card.id)}
                    onDraggingChange={onDraggingChange}
                  />
                </motion.div>
              );
            })}
          </AnimatePresence>
        </motion.div>
        {/* G-5：空列（含「异常/失败」）在任何视图下都照常渲染空态——列宽与筛选结果无关，
            「这一类确实没活」在筛选视图里同样是有效信息，不是噪声。 */}
        {!loading && column.tasks.length === 0 ? <ColumnEmpty column={column} actions={actions} /> : null}
      </motion.div>

      <ColumnFooter column={column} actions={actions} />
    </section>
  );
}

/**
 * 3.2 列头（改版后）：soft 底状态徽标胶囊（色点 + 列名）+ 可点计数胶囊。
 * 计数变化带 springs.pop 弹跳（DESIGN.md §5 数字徽标）；没有排序/折叠/筛选三项。
 * G-5 起列头只有一种形态：竖条态（色点 + 计数 + 竖排列名）随折叠规则一起删除。
 */
function ColumnHeader({
  column,
  style,
  formAction,
}: {
  column: BoardColumn;
  style: StatusStyle;
  formAction?: string;
}) {
  const label = statusLabel(column.status);
  const reduce = useReducedMotion();
  const go = () => {
    // 3.2：计数徽标本身可点；待审核跳审核页，其余跳任务列表并带上该状态。
    if (column.status === 'REVIEW') navigate('review');
    else navigate('tasks', taskListSearch({ status: column.status }));
  };
  const count = (
    <button
      type="button"
      onClick={go}
      aria-label={`查看${label}的全部任务`}
      className="ml-auto shrink-0 rounded-badge bg-bg-muted px-2 py-px text-badge text-text-secondary transition-colors duration-140 ease-settle hover:bg-border hover:text-text-primary"
    >
      <motion.span
        key={column.count}
        className="inline-block tabular-nums"
        initial={reduce ? false : { scale: 0.6 }}
        animate={{ scale: 1 }}
        transition={reduce ? { duration: 0 } : springs.pop}
      >
        {column.count}
      </motion.span>
    </button>
  );

  return (
    <header className="flex h-11 shrink-0 items-center gap-2 pb-3">
      <div
        className={cn(
          'flex h-6 min-w-0 items-center gap-1.5 rounded-badge py-0.5 pl-1.5 pr-2.5',
          style.soft,
        )}
      >
        <StatusDot className={cn('size-2 shrink-0', style.dot)} />
        <h2 className={cn('min-w-0 truncate text-badge font-medium', style.text)}>{label}</h2>
      </div>
      <span className="min-w-0 flex-1" />
      {formAction ? (
        <span className="shrink-0 rounded-tag bg-primary-light px-1.5 py-px text-badge text-primary">
          {formAction}
        </span>
      ) : null}
      {count}
    </header>
  );
}

/** 4.1「异常/失败」以外的空列：3.6 的列内空态，需求池/待执行给「+ 添加任务」。 */
function ColumnEmpty({ column, actions }: { column: BoardColumn; actions: CardActions }) {
  const creatable = column.status === 'BACKLOG' || column.status === 'READY';
  return (
    <div className="flex flex-col items-center justify-center gap-2 rounded-card border border-dashed border-border px-3 py-6 text-center">
      <ClipboardList className="size-6 text-text-tertiary" aria-hidden />
      <p className="text-card-title text-text-secondary">暂无任务</p>
      {creatable ? (
        <Button size="sm" variant="ghost" icon={<Plus className="size-3.5" />} onClick={() => actions.create(column.status)}>
          添加任务
        </Button>
      ) : null}
    </div>
  );
}

/**
 * 3.1 列底：DONE/REVIEW 常驻「查看全部 →」，需求池/待执行常驻快速新建。
 * `has_more`（超出 `board_column_limit` 被服务端截断）时改为每列常驻一行超限出口：
 * 「还有 N 条未显示 · 查看全部 →」——N = 真实计数 − 已渲染卡片数，点击仍走 seeAll 跳转。
 */
function ColumnFooter({ column, actions }: { column: BoardColumn; actions: CardActions }) {
  const creatable = column.status === 'BACKLOG' || column.status === 'READY';
  const seeAll = showsSeeAll(column);
  if (!creatable && !seeAll) return null;
  const hidden = column.has_more ? Math.max(0, column.count - column.tasks.length) : 0;
  return (
    <footer className="flex shrink-0 items-center justify-between gap-2 px-4 pb-1 pt-2">
      {creatable ? (
        <Button
          size="sm"
          variant="ghost"
          icon={<Plus className="size-3.5" />}
          onClick={() => actions.create(column.status)}
        >
          {column.status === 'READY' ? '新建并进待执行' : '新建任务'}
        </Button>
      ) : (
        <span />
      )}
      {seeAll ? (
        <span className="inline-flex min-w-0 shrink-0 items-center gap-1 text-aux">
          {hidden > 0 ? <span className="text-text-tertiary">还有 {hidden} 条未显示</span> : null}
          <button
            type="button"
            onClick={() => navigate('tasks', taskListSearch({ status: column.status }))}
            className="inline-flex shrink-0 items-center gap-0.5 text-aux text-primary hover:text-primary-hover"
          >
            查看全部
            <ChevronRight className="size-3.5" />
          </button>
        </span>
      ) : null}
    </footer>
  );
}

/** 4.4：执行中列按 Token 分组的当前 RUNNING 数量，只用于排查孤儿租约。 */
function TokenGrouping({ tasks }: { tasks: BoardColumn['tasks'] }) {
  const groups = groupRunningByToken(tasks);
  if (groups.length < 2) return null;
  return (
    <Tooltip content="按 Token 分组的执行中数量，仅用于排查孤儿租约，不构成并发限制（4.4）">
      <div className="flex flex-wrap gap-1 px-4 pb-1">
        {groups.map((group) => (
          <span key={group.agent} className="rounded-tag bg-bg-muted px-1.5 py-px text-badge text-text-secondary">
            {group.agent} {group.count}
          </span>
        ))}
      </div>
    </Tooltip>
  );
}
