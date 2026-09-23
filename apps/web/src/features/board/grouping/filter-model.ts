import { UNASSIGNED_KEY, dimensionOf, type GroupDimensionKey, type GroupableTask } from './dimensions';

/**
 * B13：分组即过滤。分组维度不再是泳道分区，而是看板的过滤条件——
 * 两个维度槽（A/B）各自多选值，任务可见性 = 两槽交集（同槽内多值是 OR）。
 * 纯函数层；持久化在 useBoardFilterStore，UI 在 GroupFilterSidebar。
 */

export type FilterSlotId = 'slotA' | 'slotB';

export interface FilterSlot {
  /** 'none' = 该槽未启用。 */
  dim: GroupDimensionKey;
  /** 选中的分组值 key（dimensions.getValues 的 key 词表）；空数组 = 不过滤。 */
  values: string[];
}

export interface BoardFilterPrefs {
  slotA: FilterSlot;
  slotB: FilterSlot;
}

export const DEFAULT_BOARD_FILTER_PREFS: BoardFilterPrefs = {
  // A 槽默认指向「分组」维度但不选值：侧栏第一眼就是分组清单。
  slotA: { dim: 'group', values: [] },
  slotB: { dim: 'none', values: [] },
};

/**
 * 可作过滤的维度。'status' 排除（六列本身就是状态，与工具栏不放状态 chip 同理）；
 * 'none' 是槽位关闭态。
 */
export const FILTERABLE_DIMENSIONS = [
  'group',
  'requirement',
  'type',
  'priority',
  'agent',
  'tag',
] as const satisfies readonly Exclude<GroupDimensionKey, 'status' | 'none'>[];

export function isFilterableDim(key: unknown): key is GroupDimensionKey {
  return key === 'none' || (FILTERABLE_DIMENSIONS as readonly string[]).includes(key as string);
}

export function taskMatchesSlot(task: GroupableTask, slot: FilterSlot): boolean {
  if (slot.dim === 'none' || slot.values.length === 0) return true;
  const dim = dimensionOf(slot.dim);
  if (!dim) return true;
  const owned = new Set(dim.getValues(task).map((value) => value.key));
  return slot.values.some((key) => owned.has(key));
}

export function taskMatchesFilter(task: GroupableTask, prefs: BoardFilterPrefs): boolean {
  return taskMatchesSlot(task, prefs.slotA) && taskMatchesSlot(task, prefs.slotB);
}

/** 任一槽选了值 = 过滤生效（空结果时不再误报「还没有任务」）。 */
export function hasActiveFilter(prefs: BoardFilterPrefs): boolean {
  return prefs.slotA.values.length > 0 || prefs.slotB.values.length > 0;
}

export function toggleSlotValue(values: readonly string[], key: string): string[] {
  return values.includes(key) ? values.filter((v) => v !== key) : [...values, key];
}

export interface FilterValueStat {
  key: string;
  label: string;
  total: number;
  review: number;
  running: number;
}

/**
 * 侧栏徽标行：每个分组值的 总数 / 执行中 / 待审核。
 * 排序：未归属垫底；优先级按 P0→P3；其余按任务数降序、同数按名称。
 */
export function slotStats(tasks: readonly GroupableTask[], dim: GroupDimensionKey): FilterValueStat[] {
  const dimension = dimensionOf(dim);
  if (!dimension) return [];
  const map = new Map<string, FilterValueStat>();
  for (const task of tasks) {
    for (const value of dimension.getValues(task)) {
      let stat = map.get(value.key);
      if (!stat) {
        stat = { key: value.key, label: value.label, total: 0, review: 0, running: 0 };
        map.set(value.key, stat);
      }
      stat.total += 1;
      if (task.status === 'REVIEW') stat.review += 1;
      if (task.status === 'RUNNING') stat.running += 1;
    }
  }
  const list = [...map.values()];
  const rank = (s: FilterValueStat) => (s.key === UNASSIGNED_KEY ? 1 : 0);
  list.sort((a, b) => {
    if (rank(a) !== rank(b)) return rank(a) - rank(b);
    if (dim === 'priority') return a.key.localeCompare(b.key);
    if (b.total !== a.total) return b.total - a.total;
    return a.label.localeCompare(b.label);
  });
  return list;
}
