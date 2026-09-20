import { create } from 'zustand';
import { useShallow } from 'zustand/react/shallow';
import { api } from '@/api';
import type { GroupDimensionKey } from './dimensions';

/**
 * 7.1–7.8 分组状态：主/次维度、泳道折叠、分组筛选、多分组、排序与偏好持久化。
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
  /** 4.5 分组多选：空数组 = 全部分组；选中 >1 时看板自动按分组泳道（原型 4.5）。 */
  groupIds: string[];
  /** 7.6 更多菜单里的组内排序。 */
  laneSort: 'manual' | 'priority' | 'updated_at';
}

export const DEFAULT_GROUPING_PREFS: GroupingPrefs = {
  // 主分组默认「状态」：退化为现有单维看板形态（六列），其他维度由分组选择器切换。
  primary: 'status',
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
  groupIds: [],
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

/** v0.0.4 W1 前（Project→Group 改名前）的本地旧形状：只列需要改写的键。 */
interface LegacyGroupingPrefs {
  projectIds?: unknown;
  primary?: unknown;
  secondary?: unknown;
}

/**
 * W1-D2：localStorage 旧分组键的一次性改写。
 * 服务端 `board.grouping` 的值已由 0008 迁移就地改名，但浏览器本地这份没人管——
 * 水合失败（离线/未登录/404）时它会成为 store 初值，`primary:"project"` 不在
 * GROUP_DIMENSIONS 词表内、`projectIds` 又喂不进 groupIds，泳道会静默错乱。
 * 改写成新口径是安全的：0008 整表重建时原样搬迁了 id（`SELECT id ... FROM projects`），
 * 旧 `projectIds` 里的值就是今天合法的分组 id，逐键换名即可，无需作废丢弃。
 * 认不出的形状（连旧键也没有的半成品 JSON）返回 null，由调用方回默认值。
 */
function rewriteLegacyGroupingPrefs(parsed: Record<string, unknown>): GroupingPrefs | null {
  const legacy = parsed as LegacyGroupingPrefs;
  const hasLegacyShape =
    Array.isArray(legacy.projectIds) || legacy.primary === 'project' || legacy.secondary === 'project';
  if (!hasLegacyShape) return null;

  const next: Record<string, unknown> = { ...parsed };
  if (next.projectIds === undefined && Array.isArray(legacy.projectIds)) {
    // 新键已存在（部分水合过）就不覆盖；否则旧 id 列表原样转正。
    next.groupIds = legacy.projectIds;
  }
  delete next.projectIds;
  if (next.primary === 'project') next.primary = 'group';
  if (next.secondary === 'project') next.secondary = 'group';

  // 折叠键/筛选泳道键是 `${dimension}:${laneKey}` 前缀式；laneOrder 的对象键则是裸维度名。
  if (isRecord(next.collapsed)) {
    next.collapsed = renameKeyPrefix(next.collapsed, 'project:', 'group:');
  }
  if (isRecord(next.laneOrder)) {
    next.laneOrder = renameExactKey(next.laneOrder as Record<string, string[]>, 'project', 'group');
  }
  if (Array.isArray(next.laneFilter)) {
    next.laneFilter = (next.laneFilter as string[]).map((key) =>
      key.startsWith('project:') ? `group:${key.slice('project:'.length)}` : key,
    );
  }
  return next as unknown as GroupingPrefs;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function renameKeyPrefix<T>(record: Record<string, T>, from: string, to: string): Record<string, T> {
  const result: Record<string, T> = {};
  for (const [key, value] of Object.entries(record)) {
    result[key.startsWith(from) ? to + key.slice(from.length) : key] = value;
  }
  return result;
}

function renameExactKey<T>(record: Record<string, T>, from: string, to: string): Record<string, T> {
  if (!(from in record)) return record;
  const { [from]: moved, ...rest } = record;
  return { ...rest, [to]: moved };
}

export function readGroupingPrefs(): GroupingPrefs {
  try {
    const raw = window.localStorage.getItem(GROUPING_PREFS_KEY);
    if (!raw) return DEFAULT_GROUPING_PREFS;
    const parsed = JSON.parse(raw) as Partial<GroupingPrefs>;
    let current: Partial<GroupingPrefs> = parsed;
    // 一次性改写旧键后立刻回写：下次读取已是新口径，rewrite 自然跳过。
    if (isRecord(parsed)) {
      const rewritten = rewriteLegacyGroupingPrefs(parsed);
      if (rewritten) {
        current = rewritten;
        try {
          window.localStorage.setItem(GROUPING_PREFS_KEY, JSON.stringify(rewritten));
        } catch {
          // 回写失败（隐私模式）不致命：本次会话内已按新口径运行。
        }
      }
    }
    return {
      ...DEFAULT_GROUPING_PREFS,
      ...current,
      options: { ...DEFAULT_GROUPING_PREFS.options, ...current.options },
    };
  } catch {
    // 隐私模式 / 损坏的 JSON：按默认值走，偏好丢失不影响正确性。
    return DEFAULT_GROUPING_PREFS;
  }
}

export function writeGroupingPrefs(prefs: GroupingPrefs): void {
  // localStorage 永远先写：服务端 PUT 失败（离线 / 5xx）时回落本地，偏好不丢。
  try {
    window.localStorage.setItem(GROUPING_PREFS_KEY, JSON.stringify(prefs));
  } catch {
    // 写失败仅丢偏好，不提示。
  }
  void api.prefs.put(GROUPING_PREFS_SERVER_KEY, prefs).catch(() => {
    // 服务端不可用：静默回落 localStorage（上面的 setItem 已写）。
  });
}

/** 模块级幂等标记：hydrate 只在首次建 store 时跑一次。 */
let prefsHydrated = false;

/**
 * 服务端 → 本地的一次性水合：GET /prefs/board.grouping，命中且合法时覆盖 store。
 * 失败（未登录 / 网络 / 404）保持 localStorage 的初值，不影响正确性。
 */
export function hydrateGroupingPrefs(): void {
  if (prefsHydrated || typeof window === 'undefined') return;
  prefsHydrated = true;
  void api.prefs
    .get(GROUPING_PREFS_SERVER_KEY)
    .then((result) => {
      if (!result.value || typeof result.value !== 'object') return;
      const parsed = result.value as Partial<GroupingPrefs>;
      const prefs: GroupingPrefs = {
        ...DEFAULT_GROUPING_PREFS,
        ...parsed,
        options: { ...DEFAULT_GROUPING_PREFS.options, ...parsed.options },
      };
      try {
        window.localStorage.setItem(GROUPING_PREFS_KEY, JSON.stringify(prefs));
      } catch {
        // 忽略：本地写失败只影响下次离线打开时的初值。
      }
      useGroupingStore.setState(prefs);
    })
    .catch(() => {
      // 回落 localStorage（store 初值已从本地读）。
    });
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
  toggleGroup: (groupId: string) => void;
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
        groupIds: state.groupIds,
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
  toggleGroup: (groupId) =>
    set((state) => {
      const groupIds = state.groupIds.includes(groupId)
        ? state.groupIds.filter((id) => id !== groupId)
        : [...state.groupIds, groupId];
      persist({ ...pickPrefs(state), groupIds });
      return { groupIds };
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
    groupIds: state.groupIds,
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

// store 建好后立刻用服务端偏好水合一次（幂等）。
hydrateGroupingPrefs();
