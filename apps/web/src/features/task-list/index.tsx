import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Archive,
  ArchiveRestore,
  ArrowLeft,
  ChevronDown,
  ChevronRight,
  Eye,
  Gavel,
  MoreHorizontal,
  Pin,
  PinOff,
  Search,
  Undo2,
} from 'lucide-react';
import { api, errorMessage, qk, useApiMutation } from '@/api';
import { useGroups, useTaskListWithGroups } from '@/features/groups';
import type { ListSortField, TaskListItem, TaskStatus } from '@/api/types';
import { BOARD_COLUMN_ORDER } from '@/api/types';
import { navigate, useRouteSearchParams } from '@/app/router';
import { filtersFromSearch, toListQuery, useFilterStore } from '@/app/store/filters';
import { useIsFlashed } from '@/app/store/flash';
import { useShellStore } from '@/app/store/shell';
import {
  Button,
  Checkbox,
  EmptyState,
  IconButton,
  Input,
  Menu,
  Pagination,
  Skeleton,
  Table,
  TBody,
  TD,
  TH,
  THead,
  TR,
} from '@/components/ui';
import type { MenuItem, MenuProps } from '@/components/ui';
import { directTransitions } from '@/features/board/matrix';
import {
  GROUPABLE_KEYS,
  GROUP_DIMENSIONS,
  toGroupable,
  type GroupDimensionKey,
} from '@/features/board/grouping/dimensions';
import { statusLabel } from '@/lib/labels';
import { cn } from '@/lib/cn';
import {
  AgentCell,
  DurationCell,
  IdCell,
  PriorityCell,
  StatusCell,
  TagsCell,
  TitleCell,
  TypeCell,
  UpdatedCell,
  displayedDurationMs,
  isArchivedRow,
  useNowTick,
} from './cells';
import { ActiveFilterSummary, ActiveGroupScope, FilterChips, FilterPanel } from './filter-panel';
import { BatchBar } from './batch-bar';
import { TASK_TABLE_COLUMNS, TASK_TABLE_MIN_WIDTH_CLASS } from './columns';
import { CreateTaskMenu } from './create-menu';
import { archiveErrorText } from './reason';
import { PAGE_SIZES, readPageSize, rememberPageSize } from './page-pref';
import { readGroupBy, rememberGroupBy } from './group-pref';

/**
 * 任务列表页 `#/tasks`（PRD 6.1 第 8 条 / 原型 3.8）：全应用**唯一**的表格实现，
 * 看板「查看全部 →」、通知铃铛、设置页「已归档任务」三处都跳到这里并带上筛选。
 *
 * 三条口径落在本文件：
 * 1. **筛选只有一份真值** —— `useFilterStore`，URL 查询串只在挂载/跳转时水合它
 *    （原型 2.2 反对的正是「两个筛选器谁覆盖谁」），页面自己不留第二套 state。
 * 2. **排序只发服务端白名单字段**（20.3：`id`/`priority`/`status`/`created_at`/`updated_at`），
 *    Agent 与时长两列不可排序——它们要聚合 `task_runs`，阶段一不做。
 * 3. **选择集跨页不清空**（原型 3.8 选择框列），所以存的是 `id → 行数据`，
 *    批量条才能报出真实条数、并拿到全部已选行的标签做「移除候选」。
 */

/** 20.3：`keyword` 上限 120（服务端 `listQuerySchema`），超长先在前端截掉。 */
const KEYWORD_MAX = 120;
/** 原型 3.8：搜索框就是 `keyword`，防抖 300ms。 */
const KEYWORD_DEBOUNCE_MS = 300;

const DEFAULT_SORT: SortState = { field: 'updated_at', order: 'desc' };

/** 20.3 排序白名单五个字段的中文名（副标题用；`created_at` 在服务端白名单内但原型 3.8 没有该列）。 */
const SORT_LABEL: Record<ListSortField, string> = {
  id: 'ID',
  priority: '优先级',
  status: '状态',
  created_at: '创建时间',
  updated_at: '更新时间',
};

interface SortState {
  field: ListSortField;
  order: 'asc' | 'desc';
}

export function TaskListPage() {
  const filters = useFilterStore();
  const search = useRouteSearchParams();

  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(readPageSize);
  const [sort, setSort] = useState<SortState>(DEFAULT_SORT);
  const [panelOpen, setPanelOpen] = useState(false);
  /** 跨页选择：`id → 行数据`，翻走的页也能被批量条引用。 */
  const [selected, setSelected] = useState<Record<string, TaskListItem>>({});

  /* ------------------------------------------------- URL 查询串 → 筛选 store */

  useEffect(() => {
    const patch = filtersFromSearch(search);
    if (patch) useFilterStore.setState(patch);
  }, [search]);

  /* ------------------------------------------------------- 关键词防抖（300ms） */

  const [keywordInput, setKeywordInput] = useState(filters.keyword);
  useEffect(() => {
    const timer = window.setTimeout(() => {
      const next = keywordInput.slice(0, KEYWORD_MAX);
      const store = useFilterStore.getState();
      if (store.keyword !== next) store.setKeyword(next);
    }, KEYWORD_DEBOUNCE_MS);
    return () => window.clearTimeout(timer);
  }, [keywordInput]);
  // 跳入时 URL 带的 keyword 只写进了 store，这里回填输入框。
  useEffect(() => setKeywordInput(filters.keyword), [filters.keyword]);

  /* --------------------------------------------------- 改筛选重置到第 1 页 */

  const filterKey = JSON.stringify([
    filters.status,
    filters.priority,
    filters.type,
    filters.tags,
    filters.customFields,
    filters.keyword,
    filters.archived,
  ]);
  const filtered = hasListFilters(filters);
  useEffect(() => {
    setPage(1);
  }, [filterKey]);

  const params = useMemo(
    () => toListQuery(filters, { page, page_size: pageSize, sort: sort.field, order: sort.order }),
    [filters, page, pageSize, sort],
  );
  // 7.8：分组多选时每分组一次 `group_id` 服务端过滤请求再按页合并（useGroupScoped）。
  const list = useTaskListWithGroups(params);
  const rows = useMemo(() => list.data?.items ?? [], [list.data]);
  const total = list.data?.total ?? 0;

  /* ----------------------------------------------- 分组分节（本页自己的显示偏好） */

  // B15-③：分节维度存在 `atb.tasks.groupBy`（`group-pref.ts`）；「不分组」时退回平铺表格。
  const [listPrimary, setListPrimary] = useState<GroupDimensionKey>(readGroupBy);
  const changeGroupBy = useCallback((key: GroupDimensionKey) => {
    setListPrimary(key);
    rememberGroupBy(key);
  }, []);
  // toGroupable 的 group_name 兜底是裸 group_id；节标题要显示真名，和看板一样查分组缓存。
  const groups = useGroups();
  const groupById = useMemo(
    () => new Map((groups.data?.items ?? []).map((group) => [group.id, group])),
    [groups.data?.items],
  );
  const sections = useMemo(() => {
    if (listPrimary === 'none') return null;
    const dim = GROUP_DIMENSIONS[listPrimary];
    const map = new Map<string, { key: string; label: string; icon: string; rows: TaskListItem[] }>();
    for (const row of rows) {
      // 标签维一张卡可归属多个分组 → 同一行会在多个节出现（与看板泳道口径一致）。
      for (const value of dim.getValues(toGroupable(row))) {
        let section = map.get(value.key);
        if (!section) {
          const group = dim.key === 'group' ? groupById.get(value.key) : undefined;
          section = {
            key: value.key,
            label: group ? group.name : value.label,
            icon: dim.icon,
            rows: [],
          };
          map.set(value.key, section);
        }
        section.rows.push(row);
      }
    }
    return [...map.values()];
  }, [rows, listPrimary, groupById]);
  const [collapsedSections, setCollapsedSections] = useState<ReadonlySet<string>>(new Set());
  const toggleSection = useCallback((key: string) => {
    setCollapsedSections((current) => {
      const next = new Set(current);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }, []);

  // 整页只有这一个秒级定时器，它同时喂租约倒计时（20.4）和 RUNNING 行的「已进行时间」
  // （`displayedDurationMs` 拿 `now` 与 `started_at` 相减），所以判据是「有 RUNNING 行」，
  // 不能只看 `lease_expires_at`——少了那个字段的行会让时长列停在挂载那一刻。
  const hasRunningRow = rows.some((row) => row.status === 'RUNNING');
  const now = useNowTick(1000, hasRunningRow);

  // 批量动作结束后要按 id 回写选择集，其中可能包含当前页之外的行——两者都要留得住。
  const rowsRef = useRef<TaskListItem[]>(rows);
  rowsRef.current = rows;
  const selectedRef = useRef(selected);
  selectedRef.current = selected;

  const onSort = useCallback((field: ListSortField) => {
    setSort((current) =>
      current.field === field
        ? { field, order: current.order === 'asc' ? 'desc' : 'asc' }
        : { field, order: field === 'priority' || field === 'id' ? 'asc' : 'desc' },
    );
    setPage(1);
  }, []);

  /* --------------------------------------------------------------- 选择集 */

  const selectedRows = useMemo(() => Object.values(selected), [selected]);
  const onPageSelected = rows.filter((row) => selected[row.id] !== undefined);
  const allPageSelected = rows.length > 0 && onPageSelected.length === rows.length;

  const toggleRow = useCallback((row: TaskListItem) => {
    setSelected((current) => {
      const next = { ...current };
      if (next[row.id]) delete next[row.id];
      else next[row.id] = row;
      return next;
    });
  }, []);

  /** 表头全选只对**当前页**生效（原型 3.8），但不清空其他页已选的行。 */
  const togglePage = useCallback(() => {
    setSelected((current) => {
      const next = { ...current };
      const everySelected = rowsRef.current.every((row) => next[row.id] !== undefined);
      for (const row of rowsRef.current) {
        if (everySelected) delete next[row.id];
        else next[row.id] = row;
      }
      return next;
    });
  }, []);

  /** 批量条回填：只保留失败项（成功项已离开原位置，再选着没意义）。 */
  const keepSelection = useCallback((ids: string[]) => {
    const pool = selectedRef.current;
    const next: Record<string, TaskListItem> = {};
    for (const id of new Set(ids)) {
      const row = pool[id] ?? rowsRef.current.find((item) => item.id === id);
      if (row) next[id] = row;
    }
    setSelected(next);
  }, []);

  /**
   * 行 `⋯` 的动作共用**一个** mutation：每行各挂一个 `useMutation` 的话，
   * 一页 200 行就是 200 份订阅，而它们要做的只是「发一条写请求 + 三处失效」。
   */
  const rowAction = useApiMutation<{ id: string; send: () => Promise<unknown> }, unknown>(
    (vars) => vars.send(),
    {
      // 单行改动也要三处失效：看板列、本页/审核页表格、可能正开着的抽屉。
      invalidate: ({ vars }) => [qk.boardRoot, qk.tasksRoot, qk.taskRoot(vars.id)],
      // 归档被下游挡住的 409 走 4.5 统一文案（`reason.ts`），其余仍是服务端 message。
      errorText: archiveErrorText,
    },
  );

  const onlyArchived = filters.archived === 'true';

  return (
    <div className="flex min-h-0 w-full flex-col gap-3">
      <header className="flex flex-wrap items-end justify-between gap-3">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            {/* 0919 十四章：任务列表不再是顶层导航，这里给显式回看板入口（hash 路由本身也支持浏览器回退）。 */}
            <Button
              size="sm"
              variant="ghost"
              icon={<ArrowLeft className="size-4" aria-hidden />}
              onClick={() => navigate('board')}
            >
              返回看板
            </Button>
            <h1 className="text-page-title text-text-primary">任务</h1>
          </div>
          <p className="text-aux text-text-secondary">
            共 {total} 条 · 第 {page} 页 · 每页 {pageSize}（默认 50、上限 200）· 按
            {SORT_LABEL[sort.field]}
            {sort.order === 'asc' ? '升序' : '降序'}
          </p>
        </div>
        <ActiveGroupScope />
        <ActiveFilterSummary />
      </header>

      <div className="flex flex-col gap-2">
        <div className="flex flex-wrap items-center gap-2">
          <div className="relative w-[280px]">
            <Search className="pointer-events-none absolute left-2 top-1/2 size-3.5 -translate-y-1/2 text-text-tertiary" />
            <Input
              aria-label="搜索标题、描述或 ID"
              className="pl-7"
              maxLength={KEYWORD_MAX}
              value={keywordInput}
              placeholder="搜索标题、描述或 ID"
              onChange={(event) => setKeywordInput(event.target.value)}
            />
          </div>
          <FilterChips panelOpen={panelOpen} onTogglePanel={() => setPanelOpen((value) => !value)} />
          <GroupByMenu value={listPrimary} onChange={changeGroupBy} />
          <Checkbox
            label="包含已归档"
            checked={filters.archived === 'all'}
            disabled={onlyArchived}
            onChange={() => filters.setArchived(filters.archived === 'all' ? 'false' : 'all')}
          />
          {onlyArchived ? (
            <Button
              size="sm"
              variant="ghost"
              className="text-primary"
              onClick={() => filters.setArchived('all')}
            >
              查看全部任务
            </Button>
          ) : null}
          {/* 原型 3.8 第 795 行：本页自己的创建入口，与 3.4 同一个下拉 + 同一个新建弹窗。 */}
          <div className="ml-auto flex shrink-0 items-center gap-2">
            <CreateTaskMenu />
          </div>
        </div>
        {panelOpen ? <FilterPanel onClose={() => setPanelOpen(false)} /> : null}
      </div>

      <div className="flex min-h-0 flex-col rounded-card border border-border bg-bg-surface shadow-card">
        {list.isPending ? (
          <div className="p-4">
            <Skeleton lines={8} />
          </div>
        ) : list.isError ? (
          <div className="flex flex-col items-start gap-2 p-4">
            <p className="text-body text-status-failed">{errorMessage(list.error)}</p>
            <Button size="sm" onClick={() => void list.refetch()}>
              重试
            </Button>
          </div>
        ) : rows.length === 0 ? (
          <EmptyState
            className="m-4"
            title={filtered ? '没有匹配的任务' : '还没有任务'}
            description={
              filtered
                ? '当前筛选组合下没有任务。清掉几个条件再试。'
                : '新建任务后会出现在看板的「需求池」列。'
            }
            action={
              filtered ? (
                <Button
                  size="sm"
                  onClick={() => {
                    filters.reset();
                    setKeywordInput('');
                  }}
                >
                  清除筛选
                </Button>
              ) : undefined
            }
          />
        ) : (
          <>
            <Table columns={TASK_TABLE_COLUMNS} className={TASK_TABLE_MIN_WIDTH_CLASS}>
              <THead>
                <TR>
                  {/* 表头从列宽模型渲染：`<colgroup>` 与 `<th>` 永远同列同序，
                      列宽只读 `columns.ts` 一处真值（td 上不再挂宽度类）。 */}
                  {TASK_TABLE_COLUMNS.map((column) =>
                    column.key === 'select' ? (
                      <TH key={column.key}>
                        <Checkbox
                          aria-label="全选当前页"
                          checked={allPageSelected}
                          indeterminate={!allPageSelected && onPageSelected.length > 0}
                          onChange={togglePage}
                        />
                      </TH>
                    ) : (
                      <TH
                        key={column.key}
                        sortField={column.sortField}
                        sort={sort}
                        onSort={column.sortField ? onSort : undefined}
                      >
                        {column.key === 'actions' ? (
                          <span className="sr-only">{column.label}</span>
                        ) : (
                          column.label
                        )}
                      </TH>
                    ),
                  )}
                </TR>
              </THead>
              <TBody>
                {sections
                  ? sections.flatMap((section) => {
                      const collapsed = collapsedSections.has(section.key);
                      const header = (
                        <TR key={`section:${section.key}`} className="bg-bg-raised">
                          <TD colSpan={TASK_TABLE_COLUMNS.length} className="py-0">
                            <button
                              type="button"
                              onClick={() => toggleSection(section.key)}
                              className="-mx-1 flex w-full items-center gap-2 py-2 text-left"
                              aria-expanded={!collapsed}
                            >
                              {collapsed ? (
                                <ChevronRight className="size-3.5 text-text-tertiary" aria-hidden />
                              ) : (
                                <ChevronDown className="size-3.5 text-text-tertiary" aria-hidden />
                              )}
                              <span aria-hidden>{section.icon}</span>
                              <span className="text-[13px] font-medium text-text-primary">{section.label}</span>
                              <span className="text-aux text-text-tertiary">{section.rows.length}</span>
                            </button>
                          </TD>
                        </TR>
                      );
                      if (collapsed) return [header];
                      return [
                        header,
                        ...section.rows.map((row) => (
                          <TaskRow
                            key={`${section.key}:${row.id}`}
                            row={row}
                            now={now}
                            onlyArchived={onlyArchived}
                            selected={selected[row.id] !== undefined}
                            onToggle={() => toggleRow(row)}
                            onAction={rowAction.mutate}
                            actionBusy={rowAction.isPending && rowAction.variables?.id === row.id}
                          />
                        )),
                      ];
                    })
                  : rows.map((row) => (
                      <TaskRow
                        key={row.id}
                        row={row}
                        now={now}
                        onlyArchived={onlyArchived}
                        selected={selected[row.id] !== undefined}
                        onToggle={() => toggleRow(row)}
                        onAction={rowAction.mutate}
                        actionBusy={rowAction.isPending && rowAction.variables?.id === row.id}
                      />
                    ))}
              </TBody>
            </Table>
            <Pagination
              className="px-4"
              total={total}
              page={page}
              pageSize={pageSize}
              onPageChange={setPage}
              pageSizes={PAGE_SIZES}
              onPageSizeChange={(size) => {
                setPageSize(size);
                rememberPageSize(size);
                setPage(1);
              }}
            />
          </>
        )}
      </div>

      {/* 选择集跨页不清空，所以加载/错误/空态三种分支下也要能对手上的任务发起批量动作。
          视觉层（DESIGN §4）：批量条是底部浮动胶囊条，fixed 定位挂在页面根部而非卡片内。 */}
      {selectedRows.length > 0 ? <BatchBar rows={selectedRows} onKeep={keepSelection} /> : null}
    </div>
  );
}

/* -------------------------------------------------------------------- 行 */

/**
 * 行单元格不再挂宽度类：列宽的唯一真值是 `columns.ts` 的 `<colgroup>`
 * （`table-layout: fixed` 下 th/td 上的宽度只是首行提示，会被 col 覆盖）。
 * 会超宽的单元格内容一律自己 truncate（见 `cells.tsx`）。
 */
function TaskRow({
  row,
  now,
  onlyArchived,
  selected,
  onToggle,
  onAction,
  actionBusy,
}: {
  row: TaskListItem;
  now: number;
  onlyArchived: boolean;
  selected: boolean;
  onToggle: () => void;
  onAction: RowMenuProps['onAction'];
  actionBusy: boolean;
}) {
  const flashed = useIsFlashed(row.id);
  return (
    <TR
      className={cn(
        flashed && 'animate-status-flash',
        // 选中行与 hover 同色（primary-light）：勾选状态在整行上有可见反馈，颜色全走 token。
        selected && 'bg-primary-light',
      )}
      onClick={() => useShellStore.getState().openTask(row.id)}
      data-testid="task-row"
    >
      <TD onClick={(event) => event.stopPropagation()}>
        <Checkbox aria-label={`选择 ${row.id}`} checked={selected} onChange={onToggle} />
      </TD>
      <TD>
        <IdCell id={row.id} />
      </TD>
      <TD>
        <TitleCell row={row} />
      </TD>
      <TD>
        <TypeCell row={row} />
      </TD>
      <TD>
        <PriorityCell priority={row.priority} />
      </TD>
      <TD>
        <StatusCell row={row} archivedShown={onlyArchived} now={now} />
      </TD>
      <TD>
        <TagsCell tags={row.tags} />
      </TD>
      <TD>
        <AgentCell row={row} />
      </TD>
      <TD>
        <DurationCell ms={displayedDurationMs(row, now)} />
      </TD>
      <TD>
        <UpdatedCell value={row.updated_at} />
      </TD>
      <TD onClick={(event) => event.stopPropagation()}>
        <RowMenu
          row={row}
          onlyArchived={onlyArchived}
          onAction={onAction}
          actionBusy={actionBusy}
        />
      </TD>
    </TR>
  );
}

/* -------------------------------------------------------------- 行操作菜单 */

/**
 * 原型 3.8：`⋯` 与卡片是**同一份按状态生成的动作集**（4.3 操作表 + 4.5 矩阵），
 * 列表页不自立一套——✅ 的落点由矩阵的 `directTransitions()` 给（见文件末尾的
 * `allowedTransitions()`），本页只负责措辞与图标。这里只挂列表页能安全直发的三类：
 * `✅` 流转、归档/恢复、置顶；
 * 「强制停止」要二次确认、「删除」要先拿 run/下游计数（4.3.1 规则 4）、
 * 审核必须走 720px 表单（6.5 三字段必填），三者都由抽屉与审核表单承担，
 * 本页给的是入口（查看详情 / 审核 →），不是第二套实现。
 */
export interface RowMenuProps {
  row: TaskListItem;
  onlyArchived: boolean;
  /** 页面级共用 mutation 的入口（每行各挂一个 useMutation 只是白占订阅）。 */
  onAction: (vars: { id: string; send: () => Promise<unknown> }) => void;
  actionBusy: boolean;
}

function RowMenu({ row, onlyArchived, onAction, actionBusy }: RowMenuProps) {
  const transitions = allowedTransitions(row.status);
  const archived = onlyArchived || isArchivedRow(row);

  const entries: (MenuItem | null)[] = [
    {
      id: 'detail',
      label: '查看详情',
      icon: <Eye className="size-3.5" aria-hidden />,
      onSelect: () => useShellStore.getState().openTask(row.id),
    },
    ...(row.status === 'REVIEW'
      ? [
          {
            id: 'review',
            label: '审核 →',
            icon: <Gavel className="size-3.5" aria-hidden />,
            hint: '三字段必填',
            onSelect: () => useShellStore.getState().openReview(row.id),
          },
        ]
      : []),
    ...transitions.map((target) => ({
      id: `to-${target}`,
      label: `移动到${statusLabel(target)}`,
      icon: <Undo2 className="size-3.5" aria-hidden />,
      onSelect: () => onAction({ id: row.id, send: () => api.tasks.transition(row.id, { to: target }) }),
    })),
    {
      id: 'pin',
      label: row.pinned ? '取消置顶' : '置顶',
      icon: row.pinned ? (
        <PinOff className="size-3.5" aria-hidden />
      ) : (
        <Pin className="size-3.5" aria-hidden />
      ),
      hint: '影响抓取顺序',
      onSelect: () =>
        onAction({
          id: row.id,
          send: () => (row.pinned ? api.tasks.unpin(row.id) : api.tasks.pin(row.id)),
        }),
    },
    row.status === 'DONE' && !archived
      ? {
          id: 'archive',
          label: '归档',
          icon: <Archive className="size-3.5" aria-hidden />,
          hint: '仅已完成',
          onSelect: () => onAction({ id: row.id, send: () => api.tasks.archive(row.id) }),
        }
      : null,
    archived
      ? {
          id: 'restore',
          label: '恢复',
          icon: <ArchiveRestore className="size-3.5" aria-hidden />,
          onSelect: () => onAction({ id: row.id, send: () => api.tasks.restore(row.id) }),
        }
      : null,
  ];
  const items: MenuItem[] = entries.filter(
    (item): item is MenuItem => item !== null,
  );

  return (
    <Menu
      align="end"
      width={216}
      groups={[{ label: `当前：${row.status_label || statusLabel(row.status)}`, items }]}
      trigger={({ open, toggle }) => (
        <IconButton
          label={`${row.id} 的操作`}
          size="iconSm"
          aria-expanded={open}
          loading={actionBusy}
          onClick={toggle}
          icon={<MoreHorizontal className="size-4" />}
        />
      )}
    />
  );
}

/**
 * 4.5 矩阵里 `✅` 的那几格——**落点只有矩阵一份**（`features/board/matrix.ts`），
 * 本页不再抄第二遍 `to:` 字面量。`🔒` 要走表单（强制停止/审核都在抽屉与审核表单里承担，
 * 本页只给「查看详情 / 审核 →」入口）、`❌` 由服务端拒，两者都不进这个菜单，
 * 所以矩阵的 ✅ 集合就是本页能安全直发的那一批。
 * 顺序按看板列序（`BOARD_COLUMN_ORDER` = 4.1 六列序）排一遍，与卡片 `⋯` 菜单读到的顺序同源。
 * 表外状态（20.2 末段）`directTransitions()` 返回空数组 = 一个写入口都不给。
 */
function allowedTransitions(status: string): TaskStatus[] {
  const targets = new Set<TaskStatus>(directTransitions(status).map((rule) => rule.to));
  return BOARD_COLUMN_ORDER.filter((to) => targets.has(to));
}

/** 空态文案判据（原型 3.8）：只看**列表查询真的带上去了**的条件，`view` 是看板预设、不算。 */
function hasListFilters(filters: {
  status: readonly unknown[];
  priority: readonly unknown[];
  type: readonly unknown[];
  tags: readonly unknown[];
  customFields: Record<string, string[]>;
  keyword: string;
  archived: string;
}): boolean {
  return (
    filters.status.length > 0 ||
    filters.priority.length > 0 ||
    filters.type.length > 0 ||
    filters.tags.length > 0 ||
    Object.keys(filters.customFields).length > 0 ||
    filters.keyword.trim().length > 0 ||
    filters.archived !== 'false'
  );
}

/* ------------------------------------------------------------ 分节维度菜单 */

/**
 * B15-③：列表页「分组方式」——分节维度的唯一入口（看板筛选弹层管过滤，这里管显示）。
 * 候选沿用 grouping 的七维 + 不分组；选中值存 `atb.tasks.groupBy`，刷新后仍在。
 */
function GroupByMenu({
  value,
  onChange,
}: {
  value: GroupDimensionKey;
  onChange: (key: GroupDimensionKey) => void;
}) {
  const groups: MenuProps['groups'] = [
    {
      label: '分节维度',
      items: [
        { id: 'none', label: '不分组', onSelect: () => onChange('none') },
        ...GROUPABLE_KEYS.map((key) => ({
          id: key as string,
          label: `${GROUP_DIMENSIONS[key].icon} ${GROUP_DIMENSIONS[key].label}`,
          onSelect: () => onChange(key),
        })),
      ],
    },
  ];
  return (
    <Menu
      width={170}
      groups={groups}
      selectedId={value}
      trigger={({ open, toggle }) => (
        <button
          type="button"
          onClick={toggle}
          aria-expanded={open}
          className={cn(
            'inline-flex h-7 shrink-0 items-center gap-1 rounded-control border px-2 text-body transition-colors duration-140 ease-settle',
            value === 'none'
              ? 'border-border text-text-secondary hover:bg-bg-muted hover:text-text-primary'
              : 'border-primary bg-primary-light text-primary',
          )}
        >
          分组方式{value === 'none' ? '' : `：${GROUP_DIMENSIONS[value].label}`}
          <ChevronDown
            className={cn('size-3.5 transition-transform duration-140 ease-settle', open && 'rotate-180')}
            aria-hidden
          />
        </button>
      )}
    />
  );
}
