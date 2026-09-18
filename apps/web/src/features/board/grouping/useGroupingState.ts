import { create } from 'zustand';
import { useShallow } from 'zustand/react/shallow';
import type { GroupDimensionKey } from './dimensions';

/**
 * 7.1–7.8 分组状态：主/次维度、泳道折叠、分组筛选、多项目、排序与偏好持久化。
 * 持久化走 `useGroupingPrefs`（约定 GET/PUT /api/v1/prefs/:key），当前是 localStorage 实现。
 */

export interface GroupingOptions {
  /** 7.7「显示空分组」。 */
  showEmptyLanes: boolean;
  /** 7.7「分组可折叠」。 */
  collapsible: boolean;
  /** 7.7「显示分组统计」。 */
  showStats: boolean;
  /** 7.7「记住分组顺序」。关掉时泳道顺序回到默认出现顺序。 */
  rememberOrder: boolean;
}

export interface GroupingPrefs {
  primary: GroupDimensionKey;
  secondary: GroupDimensionKey;
  options: GroupingOptions;
  /** 每个主维度一份泳道顺序（切换维度互不串扰）。 */
  laneOrder: Record<string, string[]>;
  /** 按主维度记忆的泳道折叠表（key: `${dimension}:${laneKey}`）。 */
  collapsed: Record<string, boolean>;
  /** 7.6 筛选分组：选中的泳道 key，空数组 = 全部。 */
  laneFilter: string[];
  /** 4.5 项目多选：空数组 = 全部项目；选中 >1 时看板自动按项目分组（原型 4.5）。 */
  projectIds: string[];
  /** 7.6 更多菜单里的组内排序。 */
  laneSort: 'manual' | 'priority' | 'updated_at';
}

export const DEFAULT_GROUPING_PREFS: GroupingPrefs = {
  primary: 'project',
  secondary: 'none',
  options: {
    showEmptyLanes: false,
    collapsible: true,
    showStats: true,
    rememberOrder: true,
  },
  laneOrder: {},
  collapsed: {},
  laneFilter: [],
  projectIds: [],
  laneSort: 'manual',
};

/**
 * 分组偏好读写（接缝）：
 * 现在是 localStorage（`atb.board.grouping`）；切服务端时把 read/write 换成
 *   GET  /api/v1/prefs/:key   → { value: <JSON> }
 *   PUT  /api/v1/prefs/:key   body: { value: <JSON> }
 * key 固定 `board.grouping`，value 即 GroupingPrefs 的 JSON。接口签名不变。
 */
export const GROUPING_PREFS_KEY = 'atb.board.grouping';
export const GROUPING_PREFS_SERVER_KEY = 'board.grouping';

export function readGroupingPrefs(): GroupingPrefs {
  try {
    const raw = window.localStorage.getItem(GROUPING_PREFS_KEY);
    if (!raw) return DEFAULT_GROUPING_PREFS;
    const parsed = JSON.parse(raw) as Partial<GroupingPrefs>;
    return { ...DEFAULT_GROUPING_PREFS, ...parsed, options: { ...DEFAULT_GROUPING_PREFS.options, ...parsed.options } };
  } catch {
    // 隐私模式 / 损坏的 JSON：按默认值走，偏好丢失不影响正确性。
    return DEFAULT_GROUPING_PREFS;
  }
}

export function writeGroupingPrefs(prefs: GroupingPrefs): void {
  try {
    window.localStorage.setItem(GROUPING_PREFS_KEY, JSON.stringify(prefs));
  } catch {
    // 写失败仅丢偏好，不提示。
  }
}

/**
 * 偏好 hook：返回当前值 + 局部更新器。store 初始化与持久化都走这里；
 * 后续接服务端只需在 read/write 实现里加缓存与 PUT，调用方不动。
 */
export function useGroupingPrefs(): {
  prefs: GroupingPrefs;
  update: (patch: Partial<GroupingPrefs>) => void;
  reset: () => void;
} {
  const prefs = useGroupingStore(useShallow(pickPrefs));
  return { prefs, update: useGroupingStore((state) => state.update), reset: useGroupingStore((state) => state.reset) };
}

export interface GroupingState extends GroupingPrefs {
  update: (patch: Partial<GroupingPrefs>) => void;
  setOptions: (patch: Partial<GroupingOptions>) => void;
  toggleLaneCollapsed: (dimension: GroupDimensionKey, laneKey: string, collapsed: boolean) => void;
  collapseAll: (dimension: GroupDimensionKey, laneKeys: readonly string[], collapsed: boolean) => void;
  setLaneOrder: (dimension: GroupDimensionKey, order: readonly string[]) => void;
  toggleLaneFilter: (laneKey: string) => void;
  setLaneFilter: (keys: readonly string[]) => void;
  toggleProject: (projectId: string) => void;
  reset: () => void;
}

const collapsedKey = (dimension: GroupDimensionKey, laneKey: string): string => `${dimension}:${laneKey}`;

function persist(prefs: GroupingPrefs): void {
  writeGroupingPrefs(prefs);
}

export const useGroupingStore = create<GroupingState>((set, get) => ({
  ...readGroupingPrefs(),
  update: (patch) =>
    set((state) => {
      const prefs: GroupingPrefs = {
        primary: state.primary,
        secondary: state.secondary,
        options: state.options,
        laneOrder: state.laneOrder,
        collapsed: state.collapsed,
        laneFilter: state.laneFilter,
        projectIds: state.projectIds,
        laneSort: state.laneSort,
        ...patch,
      };
      persist(prefs);
      return prefs;
    }),
  setOptions: (patch) => get().update({ options: { ...get().options, ...patch } }),
  toggleLaneCollapsed: (dimension, laneKey, collapsed) =>
    set((state) => {
      const key = collapsedKey(dimension, laneKey);
      const next = { ...state.collapsed };
      if (collapsed) next[key] = true;
      else delete next[key];
      persist({ ...pickPrefs(state), collapsed: next });
      return { collapsed: next };
    }),
  collapseAll: (dimension, laneKeys, collapsed) =>
    set((state) => {
      const next = { ...state.collapsed };
      for (const laneKey of laneKeys) {
        const key = collapsedKey(dimension, laneKey);
        if (collapsed) next[key] = true;
        else delete next[key];
      }
      persist({ ...pickPrefs(state), collapsed: next });
      return { collapsed: next };
    }),
  setLaneOrder: (dimension, order) =>
    set((state) => {
      const laneOrder = { ...state.laneOrder, [dimension]: [...order] };
      persist({ ...pickPrefs(state), laneOrder });
      return { laneOrder };
    }),
  toggleLaneFilter: (laneKey) =>
    set((state) => {
      const laneFilter = state.laneFilter.includes(laneKey)
        ? state.laneFilter.filter((key) => key !== laneKey)
        : [...state.laneFilter, laneKey];
      persist({ ...pickPrefs(state), laneFilter });
      return { laneFilter };
    }),
  setLaneFilter: (keys) =>
    set((state) => {
      persist({ ...pickPrefs(state), laneFilter: [...keys] });
      return { laneFilter: [...keys] };
    }),
  toggleProject: (projectId) =>
    set((state) => {
      const projectIds = state.projectIds.includes(projectId)
        ? state.projectIds.filter((id) => id !== projectId)
        : [...state.projectIds, projectId];
      persist({ ...pickPrefs(state), projectIds });
      return { projectIds };
    }),
  reset: () => {
    persist(DEFAULT_GROUPING_PREFS);
    set({ ...DEFAULT_GROUPING_PREFS });
  },
}));

/** 折叠/筛选这类局部操作也落盘：从 state 里抠出纯偏好部分再写。 */
function pickPrefs(state: GroupingState): GroupingPrefs {
  return {
    primary: state.primary,
    secondary: state.secondary,
    options: state.options,
    laneOrder: state.laneOrder,
    collapsed: state.collapsed,
    laneFilter: state.laneFilter,
    projectIds: state.projectIds,
    laneSort: state.laneSort,
  };
}

/** 泳道是否折叠（7.6 单泳道折叠）。 */
export function isLaneCollapsed(
  collapsed: Record<string, boolean>,
  dimension: GroupDimensionKey,
  laneKey: string,
): boolean {
  return collapsed[`${dimension}:${laneKey}`] === true;
}
