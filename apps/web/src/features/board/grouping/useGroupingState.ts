import { create } from 'zustand';
import { api } from '@/api';

/**
 * B13-③：泳道下线后分组偏好只剩 `groupIds` 多选（4.5 的分组作用域，
 * 驱动看板/列表的服务端过滤请求）。分组维度的选择与值过滤由
 * 过滤侧栏（useBoardFilterStore，prefs `board.filter`）承担。
 * 偏好键仍是 `board.grouping`（服务端行沿用；读到旧值里的泳道字段直接丢弃，
 * W1 改名前的 `projectIds` 就地转正——0008 迁移原样搬迁了 id，见旧注释）。
 */

export interface GroupingPrefs {
  /** 空数组 = 全部分组。 */
  groupIds: string[];
}

export const DEFAULT_GROUPING_PREFS: GroupingPrefs = { groupIds: [] };

export const GROUPING_PREFS_KEY = 'atb.board.grouping';
export const GROUPING_PREFS_SERVER_KEY = 'board.grouping';

function normalize(value: unknown): GroupingPrefs {
  const raw = (value ?? {}) as { groupIds?: unknown; projectIds?: unknown };
  const list = Array.isArray(raw.groupIds)
    ? raw.groupIds
    : Array.isArray(raw.projectIds)
      ? raw.projectIds
      : [];
  return { groupIds: list.filter((v): v is string => typeof v === 'string') };
}

export function readGroupingPrefs(): GroupingPrefs {
  try {
    const raw = window.localStorage.getItem(GROUPING_PREFS_KEY);
    if (!raw) return DEFAULT_GROUPING_PREFS;
    return normalize(JSON.parse(raw) as unknown);
  } catch {
    return DEFAULT_GROUPING_PREFS;
  }
}

let prefsHydrated = false;
let lastLocalWriteAt = 0;

export function writeGroupingPrefs(prefs: GroupingPrefs): void {
  lastLocalWriteAt = Date.now();
  try {
    window.localStorage.setItem(GROUPING_PREFS_KEY, JSON.stringify(prefs));
  } catch {
    // 写失败仅丢偏好，不提示。
  }
  void api.prefs.put(GROUPING_PREFS_SERVER_KEY, prefs).catch(() => {
    // 服务端不可用：静默回落 localStorage。
  });
}

/** 服务端 → 本地的一次性水合；失败保持 localStorage 初值。 */
export function hydrateGroupingPrefs(): void {
  if (prefsHydrated || typeof window === 'undefined') return;
  prefsHydrated = true;
  const startedAt = Date.now();
  void api.prefs
    .get(GROUPING_PREFS_SERVER_KEY)
    .then((result) => {
      // 竞态防护：GET 在途期间的本地操作不被旧服务端值覆盖（「全部分组」复位防回跳）。
      if (lastLocalWriteAt > startedAt) return;
      if (!result.value || typeof result.value !== 'object') return;
      const prefs = normalize(result.value);
      try {
        window.localStorage.setItem(GROUPING_PREFS_KEY, JSON.stringify(prefs));
      } catch {
        // 忽略：只影响下次离线打开的初值。
      }
      useGroupingStore.setState(prefs);
    })
    .catch(() => {
      // 回落 localStorage（store 初值已从本地读）。
    });
}

export interface GroupingState extends GroupingPrefs {
  update: (patch: Partial<GroupingPrefs>) => void;
  toggleGroup: (groupId: string) => void;
  reset: () => void;
}

export const useGroupingStore = create<GroupingState>((set, get) => ({
  ...readGroupingPrefs(),
  update: (patch) =>
    set((state) => {
      const prefs: GroupingPrefs = { groupIds: patch.groupIds ?? state.groupIds };
      writeGroupingPrefs(prefs);
      return prefs;
    }),
  toggleGroup: (groupId) => {
    const { groupIds } = get();
    const next = groupIds.includes(groupId)
      ? groupIds.filter((id) => id !== groupId)
      : [...groupIds, groupId];
    get().update({ groupIds: next });
  },
  reset: () => {
    writeGroupingPrefs(DEFAULT_GROUPING_PREFS);
    set({ ...DEFAULT_GROUPING_PREFS });
  },
}));

// store 建好后立刻用服务端偏好水合一次（幂等）。
hydrateGroupingPrefs();
