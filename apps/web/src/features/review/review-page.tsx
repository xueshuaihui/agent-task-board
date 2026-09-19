import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { AnimatePresence, motion, useReducedMotion } from 'motion/react';
import { ArrowDown, ArrowUp, ArrowUpDown, ChevronDown, ChevronRight, ListChecks } from 'lucide-react';
import { errorMessage, useAudit, useTaskList } from '@/api';
import type { AuditEntry, ListSortField, TaskListItem, TaskListQuery } from '@/api/types';
import { navigate } from '@/app/router';
import { taskListSearch } from '@/app/store/filters';
import { useShellStore } from '@/app/store/shell';
import {
  Badge,
  Button,
  Card,
  CardBody,
  CardHeader,
  EmptyState,
  Pagination,
  Skeleton,
  StatusDot,
  Tooltip,
  Tabs,
} from '@/components/ui';
import { cn } from '@/lib/cn';
import { itemVariants, listVariants, springs } from '@/lib/motion';
import { REVIEW_CONCLUSION_LABEL, labelOf, priorityText, statusLabel } from '@/lib/labels';
import { formatRelative } from '@/lib/time';
import { useIsFlashed } from '@/app/store/flash';
import {
  AgentCell,
  DurationCell,
  IdCell,
  PriorityCell,
  TitleCell,
  TypeCell,
  UpdatedCell,
} from '@/features/task-list/cells';
import { bindReviewQueue } from './queue';
import { useTaskReviews } from './queries';

/**
 * 8.4 / 原型 5.1 审核页：待审核队列 + 历史审核。
 *
 * 原型把这一页画成「左 320px 列表 + 右详情表单」的两栏，本期实现按交付范围改成
 * 「待审核表格 + 行内『审核』按钮 → 720px 模态」：三个入口（看板拖拽、抽屉「审核 →」、
 * 本页）必须走同一张表单与同一套校验（6.5 第 3 条），而模态的宿主已在 overlay-slot 接好，
 * 页面里再嵌一份内嵌表单就会出现两个表单实例抢同一份草稿。
 * 「跳到下一条未审核」因此由 `queue.ts` 的信号驱动，效果与原型 5.3 一致。
 */

type Tab = 'pending' | 'history';

export function ReviewPage() {
  const [tab, setTab] = useState<Tab>('pending');
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(() => 50);
  const [sort, setSort] = useState<{ field: ListSortField; order: 'asc' | 'desc' }>({
    field: 'updated_at',
    order: 'desc',
  });
  const [historyPage, setHistoryPage] = useState(1);

  /** DESIGN §1.6：尊重系统「减少动态效果」——布局/入场动画整体关掉，信息呈现不变。 */
  const reduceMotion = useReducedMotion() ?? false;

  const params = useMemo<TaskListQuery>(
    () => ({
      // 6.5 第 1 条：本页只看待审核；归档任务本来也不在该列（20.7）。
      status: ['REVIEW'],
      archived: 'false',
      page,
      page_size: pageSize,
      sort: sort.field,
      order: sort.order,
    }),
    [page, pageSize, sort.field, sort.order],
  );
  const list = useTaskList(params);
  const rows = list.data?.items ?? [];
  const total = list.data?.total ?? 0;

  /* ------------------------------------------- 6.5 / 原型 5.3 提交后跳下一条 */

  const idsRef = useRef<string[]>([]);
  idsRef.current = rows.map((row) => row.id);
  const [handled, setHandled] = useState<string[]>([]);

  useEffect(() => {
    bindReviewQueue((taskId) => {
      const done = new Set([...handled, taskId]);
      const next = idsRef.current.find((id) => !done.has(id));
      setHandled([...done]);
      if (next) useShellStore.getState().openReview(next);
    });
    return () => bindReviewQueue(null);
  }, [handled]);

  const queueDrained = handled.length > 0 && rows.every((row) => handled.includes(row.id));

  const onSort = useCallback((field: ListSortField) => {
    setSort((current) =>
      current.field === field
        ? { field, order: current.order === 'asc' ? 'desc' : 'asc' }
        : { field, order: field === 'priority' || field === 'id' ? 'asc' : 'desc' },
    );
    setPage(1);
  }, []);

  const history = useAudit({ page: historyPage });
  const reviewEntries = useMemo(
    () => (history.data?.items ?? []).filter(isReviewSubmit),
    [history.data],
  );

  return (
    <div className="flex min-h-0 w-full flex-col gap-4">
      <header className="flex flex-wrap items-end justify-between gap-3">
        <div className="min-w-0">
          <h1 className="text-page-title text-text-primary">审核</h1>
          <p className="text-aux text-text-secondary">
            待审核 {total} 条 · 通过与驳回都要留三字段（6.5），Agent 下次领取可读本次意见（6.6）
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Tabs
            ariaLabel="审核视图"
            variant="segmented"
            value={tab}
            onChange={(value) => setTab(value as Tab)}
            items={[
              { value: 'pending', label: '待审核', count: total },
              { value: 'history', label: '历史审核' },
            ]}
          />
          <Button
            size="sm"
            icon={<ListChecks className="size-4" aria-hidden />}
            onClick={() => navigate('tasks', taskListSearch({ status: 'REVIEW' }))}
          >
            在任务列表里筛
          </Button>
        </div>
      </header>

      {tab === 'pending' ? (
        <Card className="min-h-0">
          <CardHeader className="justify-between">
            <span className="text-card-title text-text-primary">待审核队列</span>
            <span className="text-aux text-text-secondary">
              第 {page} 页 · 共 {total} 条
            </span>
          </CardHeader>
          <CardBody className="flex min-h-0 flex-col gap-3 p-0">
            {queueDrained ? (
              <p className="mx-4 mt-3 rounded-control bg-status-done-soft px-3 py-2 text-aux text-status-done">
                队列已清空：本列的任务都已给出审核结论。
              </p>
            ) : null}
            {list.isPending ? (
              <div className="px-4 py-3">
                <Skeleton lines={6} />
              </div>
            ) : list.isError ? (
              <div className="flex flex-col items-start gap-2 px-4 py-3">
                <p className="text-body text-status-failed">{errorMessage(list.error)}</p>
                <Button size="sm" onClick={() => void list.refetch()}>
                  重试
                </Button>
              </div>
            ) : rows.length === 0 ? (
              <EmptyState
                className="mx-4 mb-4"
                title="没有待审核的任务"
                description="Agent 完成执行回写后，任务会进入这一列并出现在这里。"
              />
            ) : (
              <>
                {/*
                 * DESIGN §4 审核：队列改成卡片列表（原表格的实现注释见文件头，排序能力保留，
                 * 从表头按钮迁到卡片上方的排序条）；卡片入场 stagger + 队列变化时 layout 滑动。
                 */}
                <div className="flex flex-wrap items-center gap-1 px-4 pt-3 text-aux text-text-secondary">
                  {QUEUE_SORTS.map((item) => (
                    <SortButton key={item.field} {...item} sort={sort} onSort={onSort} />
                  ))}
                </div>
                <motion.ul
                  variants={reduceMotion ? undefined : listVariants}
                  initial={reduceMotion ? false : 'hidden'}
                  animate={reduceMotion ? undefined : 'show'}
                  className="flex flex-col gap-2 px-4 pb-1"
                >
                  <AnimatePresence>
                    {rows.map((row, index) => (
                      <PendingRow key={row.id} row={row} index={index} reduced={reduceMotion} />
                    ))}
                  </AnimatePresence>
                </motion.ul>
              </>
            )}
            <Pagination
              className="px-4"
              total={total}
              page={page}
              pageSize={pageSize}
              onPageChange={setPage}
              onPageSizeChange={(size) => {
                setPageSize(size);
                setPage(1);
              }}
            />
          </CardBody>
        </Card>
      ) : (
        <Card className="min-h-0">
          <CardHeader className="justify-between">
            <span className="text-card-title text-text-primary">历史审核</span>
            <span className="text-aux text-text-secondary">
              审计流里的 review_submit · 第 {historyPage} 页
            </span>
          </CardHeader>
          <CardBody className="flex min-h-0 flex-col gap-3">
            <p className="text-aux text-text-tertiary">
              服务端没有跨任务的审核列表端点（13 章只给{' '}
              <code className="font-mono" data-selectable>
                GET /tasks/&#123;id&#125;/reviews
              </code>
              ），这一栏读的是审计流的 review_submit 事件；点开行看三字段全文。
            </p>
            {history.isPending ? <Skeleton lines={5} /> : null}
            {history.isError ? (
              <div className="flex flex-col items-start gap-2">
                <p className="text-body text-status-failed">{errorMessage(history.error)}</p>
                <Button size="sm" onClick={() => void history.refetch()}>
                  重试
                </Button>
              </div>
            ) : null}
            {!history.isPending && !history.isError && reviewEntries.length === 0 ? (
              <EmptyState
                title="本页审计里没有审核记录"
                description="审计每页固定 50 条、时间倒序（13 章）；翻页看看更早的记录。"
              />
            ) : null}
            <ul className="flex flex-col">
              {reviewEntries.map((entry) => (
                <HistoryRow key={entry.id} entry={entry} />
              ))}
            </ul>
            <Pagination
              total={history.data?.total ?? 0}
              page={historyPage}
              pageSize={history.data?.page_size ?? 50}
              onPageChange={setHistoryPage}
            />
          </CardBody>
        </Card>
      )}
    </div>
  );
}

/* ------------------------------------------------------------------ 行组件 */

/** 队列卡片沿用原表格的三个可排序字段（id / priority / updated_at），交互口径不变。 */
const QUEUE_SORTS: readonly { field: ListSortField; label: string }[] = [
  { field: 'id', label: 'ID' },
  { field: 'priority', label: '优先级' },
  { field: 'updated_at', label: '更新时间' },
];

function SortButton({
  field,
  label,
  sort,
  onSort,
}: {
  field: ListSortField;
  label: string;
  sort: { field: ListSortField; order: 'asc' | 'desc' };
  onSort: (field: ListSortField) => void;
}) {
  const active = sort.field === field;
  return (
    <button
      type="button"
      onClick={() => onSort(field)}
      className={cn(
        'inline-flex items-center gap-1 rounded-control px-1.5 py-1 hover:text-text-primary',
        active && 'text-text-primary',
      )}
    >
      {label}
      {active ? (
        sort.order === 'asc' ? (
          <ArrowUp className="size-3 text-primary" aria-hidden />
        ) : (
          <ArrowDown className="size-3 text-primary" aria-hidden />
        )
      ) : (
        <ArrowUpDown className="size-3 text-text-tertiary" aria-hidden />
      )}
    </button>
  );
}

/**
 * DESIGN §4 审核：待审核队列卡片。原表格行的全部信息与交互原样保留
 * （整卡点击开抽屉、操作区 stopPropagation、审核按钮、回写提示点、状态闪烁），
 * 外层换成 motion.li：入场 stagger、队列变化时 layout 滑动、离场淡出。
 */
function PendingRow({ row, index, reduced }: { row: TaskListItem; index: number; reduced: boolean }) {
  const flashed = useIsFlashed(row.id);
  return (
    <motion.li
      layout={!reduced}
      transition={springs.gentle}
      variants={reduced ? undefined : itemVariants}
      // 显式 initial/animate：不能依赖父容器 stagger 编排——数据晚到的行会卡在
      // hidden 态永远不可见（内容「塌陷」）。stagger 顺序由 custom 索引延迟保证。
      initial={reduced ? false : 'hidden'}
      animate={reduced ? undefined : 'show'}
      custom={index}
      exit={reduced ? undefined : { opacity: 0, transition: { duration: 0.15 } }}
      className="list-none"
    >
      <div
        className={cn(
          'cursor-pointer rounded-card border border-border bg-bg-surface shadow-card',
          'transition-[transform,box-shadow,border-color] duration-140 ease-out',
          'hover:-translate-y-0.5 hover:border-border-strong hover:shadow-card-hover',
          flashed && 'animate-status-flash',
        )}
        onClick={() => useShellStore.getState().openTask(row.id)}
      >
        <div className="flex items-center gap-2 px-3 pt-2.5">
          <IdCell id={row.id} />
          <div className="min-w-0 flex-1">
            <TitleCell row={row} />
          </div>
          <UpdatedCell value={row.updated_at} />
          <div className="flex items-center gap-1" onClick={(event) => event.stopPropagation()}>
            {/* stopPropagation 直接挂在按钮上（而不仅外层容器）：保证「审核」在任何
                事件路径下都只开审核表单、不会误触整卡的 openTask。 */}
            <Button
              size="sm"
              variant="primary"
              onClick={(event) => {
                event.stopPropagation();
                useShellStore.getState().openReview(row.id);
              }}
            >
              审核
            </Button>
            <Tooltip content={`第 ${row.run_count} 次执行回写待判`}>
              <StatusDot className="bg-status-review" />
            </Tooltip>
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-x-4 gap-y-0.5 px-3 pb-2.5 pt-1">
          <TypeCell row={row} />
          <PriorityCell priority={row.priority} />
          <AgentCell row={row} />
          <DurationCell ms={row.duration_ms} />
        </div>
      </div>
    </motion.li>
  );
}

/**
 * 6.8：审核提交写的是 `audit_logs(action='review_submit', target_type='review',
 * target_id=<任务 id>)` —— `target_id` 指向任务，所以能直接开抽屉、也能按它回查 reviews。
 */
function isReviewSubmit(entry: AuditEntry): boolean {
  return entry.action === 'review_submit' && typeof entry.target_id === 'string';
}

function HistoryRow({ entry }: { entry: AuditEntry }) {
  const [open, setOpen] = useState(false);
  const taskId = entry.target_id as string;
  const reviews = useTaskReviews(open ? taskId : null);
  const outcome = outcomeOf(entry);

  return (
    <li className="border-b border-border last:border-b-0">
      <div className="flex flex-wrap items-center gap-2 py-2">
        <button
          type="button"
          aria-expanded={open}
          onClick={() => setOpen((value) => !value)}
          className="inline-flex items-center gap-1 text-text-secondary hover:text-text-primary"
        >
          {open ? (
            <ChevronDown className="size-3.5" aria-hidden />
          ) : (
            <ChevronRight className="size-3.5" aria-hidden />
          )}
        </button>
        <button
          type="button"
          className="font-mono text-code text-text-secondary hover:text-primary"
          onClick={() => useShellStore.getState().openTask(taskId)}
        >
          {taskId}
        </button>
        {outcome?.conclusion ? (
          <Badge className={conclusionClass(outcome.conclusion)}>
            {labelOf(REVIEW_CONCLUSION_LABEL, outcome.conclusion)}
          </Badge>
        ) : null}
        {outcome?.status ? (
          <span className="text-aux text-text-secondary">→ {statusLabel(outcome.status)}</span>
        ) : null}
        {entry.actor_name ? (
          <span className="text-aux text-text-tertiary">{entry.actor_name}</span>
        ) : null}
        <span className="ml-auto text-aux text-text-tertiary">{formatRelative(entry.created_at)}</span>
      </div>
      {open ? (
        <div className="pb-3 pl-6">
          {reviews.isPending ? (
            <Skeleton lines={2} />
          ) : reviews.isError ? (
            <p className="text-aux text-status-failed">{errorMessage(reviews.error)}</p>
          ) : (
            <ul className="flex flex-col gap-2">
              {(reviews.data?.items ?? []).map((review) => (
                <li
                  key={review.id}
                  className="rounded-control border border-border bg-bg-muted px-3 py-2"
                >
                  <Opinion label="审核建议" value={review.suggestion} />
                  <Opinion label="原因" value={review.reason} />
                  <Opinion label="详情" value={review.detail} />
                  <p className="mt-1 text-aux text-text-tertiary">
                    {formatRelative(review.created_at)} · {review.run_id ?? '无关联 Run'}
                    {review.return_to ? ` · 退回 ${statusLabel(review.return_to)}` : ''}
                    {review.priority_adj !== null && review.priority_adj !== undefined
                      ? ` · 优先级调为 ${priorityText(review.priority_adj)}`
                      : ''}
                  </p>
                </li>
              ))}
            </ul>
          )}
        </div>
      ) : null}
    </li>
  );
}

function Opinion({ label, value }: { label: string; value: string }) {
  return (
    <p className="text-body text-text-primary" data-selectable>
      <span className="text-aux text-text-tertiary">{label}：</span>
      {value}
    </p>
  );
}

/** 1.1 状态色：只有两个已知结论各有自己的底色，表外值走中性描边（20.11 不借用「驳回」的红）。 */
function conclusionClass(conclusion: string): string {
  if (conclusion === 'APPROVE') return 'bg-status-done-soft text-status-done';
  if (conclusion === 'REJECT') return 'bg-status-failed-soft text-status-failed';
  return 'border border-border text-text-secondary';
}

function outcomeOf(entry: AuditEntry): { conclusion?: string; status?: string } | null {
  const after = entry.after;
  if (!after || typeof after !== 'object') return null;
  const record = after as Record<string, unknown>;
  return {
    conclusion: typeof record.conclusion === 'string' ? record.conclusion : undefined,
    status: typeof record.status === 'string' ? record.status : undefined,
  };
}
