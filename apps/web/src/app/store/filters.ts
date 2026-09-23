import { create } from 'zustand';
import type { ArchivedFilter, BoardQuery, BoardView, TaskListQuery, TaskStatus } from '@/api/types';
import { TASK_STATUSES } from '@/api/types';

/**
 * 3.5 与 3.8 共用**同一个**筛选 store（原型 3.8 明确写了这点），两页的差别只在于
 * 列表页多一个「状态」筛选组——看板用六列表达状态，列表没有列，状态必须能筛。
 *
 * 跨页跳转靠 URL 查询串携带条件（列底「查看全部 →」、通知铃铛、设置页「已归档任务」入口
 * 都是跳 `/tasks?status=...`），落地页在挂载时用 `filtersFromSearch()` 水合本 store，
 * 这样 store 里永远只有一份筛选真值，不会出现「两个筛选器谁覆盖谁」（原型 2.2）。
 */
export interface FilterState {
  /** 3.4 视图预设：过滤卡片、不改变列结构。 */
  view: BoardView;
  priority: number[];
  type: string[];
  tags: string[];
  /** B15：看板统一过滤维度（服务端多值参数，维内 OR；`none` = 该维未设置）。 */
  groups: string[];
  requirements: string[];
  agents: string[];
  /** 键为字段 key（^[a-z][a-z0-9_]{1,31}$），值为候选项数组。 */
  customFields: Record<string, string[]>;
  /** 仅列表页使用。 */
  status: TaskStatus[];
  keyword: string;
  archived: ArchivedFilter;

  setView: (view: BoardView) => void;
  setKeyword: (keyword: string) => void;
  setArchived: (archived: ArchivedFilter) => void;
  toggleNumber: (key: 'priority', value: number) => void;
  toggleString: (
    key: 'type' | 'tags' | 'status' | 'groups' | 'requirements' | 'agents',
    value: string,
  ) => void;
  /** 程序化批量设值（URL 水合、筛选弹层整维设置、分组页直达）；数组空 = 该维不过滤。 */
  setDimension: (key: 'groups' | 'requirements' | 'agents', values: string[]) => void;
  setCustomField: (fieldKey: string, values: string[]) => void;
  clearGroup: (
    key:
      | 'priority'
      | 'type'
      | 'tags'
      | 'status'
      | 'customFields'
      | 'keyword'
      | 'groups'
      | 'requirements'
      | 'agents',
  ) => void;
  reset: () => void;
}

const EMPTY = {
  view: 'all' as BoardView,
  priority: [] as number[],
  type: [] as string[],
  tags: [] as string[],
  groups: [] as string[],
  requirements: [] as string[],
  agents: [] as string[],
  customFields: {} as Record<string, string[]>,
  status: [] as TaskStatus[],
  keyword: '',
  archived: 'false' as ArchivedFilter,
};

function toggleIn<T>(list: T[], value: T): T[] {
  return list.includes(value) ? list.filter((item) => item !== value) : [...list, value];
}

export const useFilterStore = create<FilterState>((set) => ({
  ...EMPTY,
  setView: (view) => set({ view }),
  setKeyword: (keyword) => set({ keyword }),
  setArchived: (archived) => set({ archived }),
  toggleNumber: (key, value) => set((state) => ({ [key]: toggleIn(state[key], value) })),
  toggleString: (key, value) =>
    set((state) =>
      key === 'status'
        ? { status: toggleIn(state.status, value as TaskStatus) }
        : { [key]: toggleIn(state[key], value) },
    ),
  setDimension: (key, values) => set({ [key]: [...values] } as Pick<FilterState, typeof key>),
  setCustomField: (fieldKey, values) =>
    set((state) => {
      const next = { ...state.customFields };
      if (values.length === 0) delete next[fieldKey];
      else next[fieldKey] = values;
      return { customFields: next };
    }),
  clearGroup: (key) =>
    set(() =>
      key === 'customFields'
        ? { customFields: {} }
        : key === 'keyword'
          ? { keyword: '' }
          : { [key]: [] },
    ),
  reset: () => set({ ...EMPTY }),
}));

/* ------------------------------------------------------------------ 选择器 */

/** 20.7：board 不接受 `status`，六列本身就是状态。 */
export function toBoardQuery(state: FilterState): BoardQuery {
  const query: BoardQuery = { view: state.view };
  if (state.priority.length) query.priority = state.priority;
  if (state.type.length) query.type = state.type;
  if (state.tags.length) query.tags = state.tags;
  if (state.groups.length) query.groups = state.groups;
  if (state.requirements.length) query.requirements = state.requirements;
  if (state.agents.length) query.agents = state.agents;
  if (Object.keys(state.customFields).length) {
    query.custom_fields = { ...state.customFields };
  }
  return query;
}

export function toListQuery(
  state: FilterState,
  page: { page: number; page_size: number; sort?: TaskListQuery['sort']; order?: 'asc' | 'desc' },
): TaskListQuery {
  const query: TaskListQuery = {
    page: page.page,
    page_size: page.page_size,
    sort: page.sort ?? 'updated_at',
    order: page.order ?? 'desc',
    archived: state.archived,
  };
  if (state.status.length) query.status = state.status;
  if (state.keyword.trim()) query.keyword = state.keyword.trim();
  if (state.priority.length) query.priority = state.priority;
  if (state.type.length) query.type = state.type;
  if (state.tags.length) query.tags = state.tags;
  if (Object.keys(state.customFields).length) {
    query.custom_fields = { ...state.customFields };
  }
  return query;
}

/** chip 区与「清除筛选」按钮的判据。 */
export function activeFilterCount(state: FilterState): number {
  return (
    (state.view !== 'all' ? 1 : 0) +
    state.priority.length +
    state.type.length +
    state.tags.length +
    state.groups.length +
    state.requirements.length +
    state.agents.length +
    state.status.length +
    Object.keys(state.customFields).length +
    (state.keyword.trim() ? 1 : 0) +
    (state.archived !== 'false' ? 1 : 0)
  );
}

/* ------------------------------------------------- URL 查询串 ←→ 筛选状态 */

/** 从 hash 的查询串水合筛选（跳入列表页时用）；无相关参数时返回 null，调用方就别 reset。 */
export function filtersFromSearch(
  search: URLSearchParams,
): Partial<
  Pick<
    FilterState,
    | 'view'
    | 'priority'
    | 'type'
    | 'tags'
    | 'groups'
    | 'requirements'
    | 'agents'
    | 'status'
    | 'keyword'
    | 'archived'
  >
> | null {
  const patch: Partial<FilterState> = {};
  const view = search.get('view');
  if (isBoardView(view)) patch.view = view;
  const status = search
    .getAll('status')
    .flatMap((value) => value.split(','))
    .filter((value): value is TaskStatus => (TASK_STATUSES as readonly string[]).includes(value));
  if (status.length) patch.status = status;
  const priority = search
    .getAll('priority')
    .flatMap((value) => value.split(','))
    .map(Number)
    .filter((value) => Number.isInteger(value) && value >= 0 && value <= 3);
  if (priority.length) patch.priority = priority;
  const type = listFrom(search, 'type');
  if (type.length) patch.type = type;
  const tags = listFrom(search, 'tags');
  if (tags.length) patch.tags = tags;
  const groups = listFrom(search, 'groups');
  if (groups.length) patch.groups = groups;
  const requirements = listFrom(search, 'requirements');
  if (requirements.length) patch.requirements = requirements;
  const agents = listFrom(search, 'agents');
  if (agents.length) patch.agents = agents;
  const keyword = search.get('keyword');
  if (keyword) patch.keyword = keyword;
  const archived = search.get('archived');
  if (archived === 'true' || archived === 'all' || archived === 'false') patch.archived = archived;
  patch.archived ??= 'false';
  return Object.keys(patch).length > 0 ? patch : null;
}

function listFrom(search: URLSearchParams, key: string): string[] {
  return search
    .getAll(key)
    .flatMap((value) => value.split(','))
    .map((value) => value.trim())
    .filter(Boolean);
}

function isBoardView(value: string | null): value is BoardView {
  return value === 'all' || value === 'review' || value === 'failed' || value === 'claimable' || value === 'blocked';
}

/** 看板列头/列底跳转时构造 `/tasks` 的查询串。 */
export function taskListSearch(input: {
  status?: TaskStatus | TaskStatus[];
  archived?: ArchivedFilter;
  keyword?: string;
  view?: BoardView;
}): string {
  const search = new URLSearchParams();
  const statuses = input.status === undefined ? [] : [input.status].flat();
  if (statuses.length) search.set('status', statuses.join(','));
  if (input.archived && input.archived !== 'false') search.set('archived', input.archived);
  if (input.keyword) search.set('keyword', input.keyword);
  if (input.view) search.set('view', input.view);
  const encoded = search.toString();
  return encoded ? `?${encoded}` : '';
}

/**
 * B15：看板过滤态 → `#/board` 的查询串（可分享、可书签）。只序列化服务端过滤维度；
 * custom_fields 不进 URL（其 key 自由、值含逗号/空格，编解码收益低、坑多）。
 */
export function boardFilterSearch(
  state: Pick<
    FilterState,
    'view' | 'priority' | 'type' | 'tags' | 'groups' | 'requirements' | 'agents'
  >,
): string {
  const search = new URLSearchParams();
  if (state.view !== 'all') search.set('view', state.view);
  if (state.priority.length) search.set('priority', state.priority.join(','));
  if (state.type.length) search.set('type', state.type.join(','));
  if (state.tags.length) search.set('tags', state.tags.join(','));
  if (state.groups.length) search.set('groups', state.groups.join(','));
  if (state.requirements.length) search.set('requirements', state.requirements.join(','));
  if (state.agents.length) search.set('agents', state.agents.join(','));
  const encoded = search.toString();
  return encoded ? `?${encoded}` : '';
}
