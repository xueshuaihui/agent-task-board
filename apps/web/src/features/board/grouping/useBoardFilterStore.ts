import { create } from 'zustand';
import { api } from '@/api';
import type { GroupDimensionKey } from './dimensions';
import {
  DEFAULT_BOARD_FILTER_PREFS,
  isFilterableDim,
  toggleSlotValue,
  type BoardFilterPrefs,
  type FilterSlot,
  type FilterSlotId,
} from './filter-model';

/**
 * B13 过滤偏好持久化：localStorage `atb.board.filter` + 服务端 prefs `board.filter`
 * （GET/PUT /api/v1/prefs/:key），读写与水合竞态防护沿用 useGroupingState 的套路。
 */

export const BOARD_FILTER_PREFS_KEY = 'atb.board.filter';
export const BOARD_FILTER_PREFS_SERVER_KEY = 'board.filter';

function sanitizeSlot(value: unknown, fallback: FilterSlot): FilterSlot {
  if (typeof value !== 'object' || value === null) return fallback;
  const slot = value as Partial<FilterSlot>;
  if (!isFilterableDim(slot.dim)) return fallback;
  const values = Array.isArray(slot.values) ? slot.values.filter((v): v is string => typeof v === 'string') : [];
  return { dim: slot.dim as GroupDimensionKey, values };
}

/** 两槽撞同一维度时 B 槽关闭（交集退化成同一份过滤，没有意义）。 */
function dedupeSlots(prefs: BoardFilterPrefs): BoardFilterPrefs {
  if (prefs.slotA.dim !== 'none' && prefs.slotA.dim === prefs.slotB.dim) {
    return { ...prefs, slotB: { dim: 'none', values: [] } };
  }
  return prefs;
}

function normalize(partial: Partial<BoardFilterPrefs> | null | undefined): BoardFilterPrefs {
  const p = partial ?? {};
  return dedupeSlots({
    slotA: sanitizeSlot(p.slotA, DEFAULT_BOARD_FILTER_PREFS.slotA),
    slotB: sanitizeSlot(p.slotB, DEFAULT_BOARD_FILTER_PREFS.slotB),
  });
}

export function readBoardFilterPrefs(): BoardFilterPrefs {
  try {
    const raw = window.localStorage.getItem(BOARD_FILTER_PREFS_KEY);
    if (!raw) return DEFAULT_BOARD_FILTER_PREFS;
    return normalize(JSON.parse(raw) as Partial<BoardFilterPrefs>);
  } catch {
    return DEFAULT_BOARD_FILTER_PREFS;
  }
}

let prefsHydrated = false;
let lastLocalWriteAt = 0;

function persist(prefs: BoardFilterPrefs): void {
  lastLocalWriteAt = Date.now();
  try {
    window.localStorage.setItem(BOARD_FILTER_PREFS_KEY, JSON.stringify(prefs));
  } catch {
    // 写失败仅丢偏好，不提示。
  }
  void api.prefs.put(BOARD_FILTER_PREFS_SERVER_KEY, prefs).catch(() => {
    // 服务端不可用：静默回落 localStorage。
  });
}

export function hydrateBoardFilterPrefs(): void {
  if (prefsHydrated || typeof window === 'undefined') return;
  prefsHydrated = true;
  const startedAt = Date.now();
  void api.prefs
    .get(BOARD_FILTER_PREFS_SERVER_KEY)
    .then((result) => {
      // 竞态防护同 grouping：GET 在途期间的本地操作不被旧服务端值覆盖。
      if (lastLocalWriteAt > startedAt) return;
      if (!result.value || typeof result.value !== 'object') return;
      const prefs = normalize(result.value as Partial<BoardFilterPrefs>);
      try {
        window.localStorage.setItem(BOARD_FILTER_PREFS_KEY, JSON.stringify(prefs));
      } catch {
        // 忽略：只影响下次离线打开的初值。
      }
      useBoardFilterStore.setState(prefs);
    })
    .catch(() => {
      // 回落 localStorage（store 初值已从本地读）。
    });
}

export interface BoardFilterState extends BoardFilterPrefs {
  setSlotDim: (slot: FilterSlotId, dim: GroupDimensionKey) => void;
  toggleValue: (slot: FilterSlotId, key: string) => void;
  clearSlot: (slot: FilterSlotId) => void;
  reset: () => void;
}

export const useBoardFilterStore = create<BoardFilterState>((set) => ({
  ...readBoardFilterPrefs(),
  setSlotDim: (slot, dim) =>
    set((state) => {
      const next = normalize({ ...state, [slot]: { dim, values: [] } });
      persist(next);
      return next;
    }),
  toggleValue: (slot, key) =>
    set((state) => {
      const current = state[slot];
      const next = normalize({
        ...state,
        [slot]: { ...current, values: toggleSlotValue(current.values, key) },
      });
      persist(next);
      return next;
    }),
  clearSlot: (slot) =>
    set((state) => {
      const next = normalize({ ...state, [slot]: { ...state[slot], values: [] } });
      persist(next);
      return next;
    }),
  reset: () => {
    persist(DEFAULT_BOARD_FILTER_PREFS);
    set({ ...DEFAULT_BOARD_FILTER_PREFS });
  },
}));

// store 建好后立刻用服务端偏好水合一次（幂等）。
hydrateBoardFilterPrefs();
