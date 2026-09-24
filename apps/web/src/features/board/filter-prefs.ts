import { api } from '@/api';
import type { BoardView } from '@/api/types';
import { useFilterStore, type FilterState } from '@/app/store/filters';
import { UNASSIGNED_KEY } from './grouping/dimensions';

/**
 * B15-②：看板统一过滤的**持久化 + URL 同步**层。
 *
 * 真值只有一份——`useFilterStore`（app/store/filters.ts）；本模块负责把它在看板侧的
 * 子集（view/priority/type/tags/requirements/agents/customFields）双写：
 * - **设备偏好**：localStorage `atb.board.filter` + 服务端 prefs `board.filter`（v2 扁平
 *   形状；读写与水合竞态防护沿用 B13/useGroupingState 的套路）；
 * - **URL**：看板页内经 `useBoardFilterUrlSync()` 双向同步 `#/board?...`
 *   （挂载/跳转时 URL 优先，之后 store 变更用 `replaceState` 回写、不产生历史条目）。
 *
 * §19.14（2026-09-24 拍板）：groups 维从看板下线——**持久化切片不再包含 groups**，
 * 历史偏好里的 groups 值与旧迁移链里的分组作用域一律「读取时丢弃、不回写」。
 *
 * 一次性迁移（读到才转，转完按 v2 落盘）：
 * - v1 槽形状 `{ slotA, slotB }`（B13「分组即过滤」）→ 对应维度的数组（`dim==='group'`
 *   的历史槽值丢弃）；
 * - 旧 `board.grouping`（只读迁移链保留）→ 泳道时代的 `primary/laneFilter` 仍翻进
 *   对应维度；`groupIds/projectIds` 作用域值丢弃。
 */

export const BOARD_FILTER_LOCAL_KEY = 'atb.board.filter';
export const BOARD_FILTER_SERVER_KEY = 'board.filter';
/**
 * 旧分组作用域偏好（B13 前）；只作迁移输入，store 已随 B15-②b 下线。
 * §19.14：链路保留（旧键仍被读取，laneFilter/primary 照常翻译），但其中的
 * `groupIds/projectIds` 值读取时丢弃、不回写。
 */
export const GROUPING_LOCAL_KEY = 'atb.board.grouping';
export const GROUPING_SERVER_KEY = 'board.grouping';

/* ------------------------------------------------------------------ 形状 */

/** v2 偏好 = 看板过滤子集（列表页专属的 status/keyword/archived 不持久化；§19.14 起 groups 不持久化）。 */
export type BoardFilterPrefs = Pick<
  FilterState,
  'view' | 'priority' | 'type' | 'tags' | 'requirements' | 'agents' | 'customFields'
>;

export const DEFAULT_BOARD_FILTER_PREFS: BoardFilterPrefs = {
  view: 'all',
  priority: [],
  type: [],
  tags: [],
  requirements: [],
  agents: [],
  customFields: {},
};

const BOARD_VIEW_VALUES: readonly BoardView[] = ['all', 'review', 'failed', 'claimable', 'blocked'];

function strList(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string') : [];
}

function uniq(list: string[]): string[] {
  return [...new Set(list)];
}

function normalizePriority(value: unknown): number[] {
  if (!Array.isArray(value)) return [];
  return [
    ...new Set(
      value.filter((v): v is number => typeof v === 'number' && Number.isInteger(v) && v >= 0 && v <= 3),
    ),
  ];
}

/* -------------------------------------------------------------- 归一化 */

export function normalizeBoardFilterPrefs(input: unknown): BoardFilterPrefs {
  if (typeof input !== 'object' || input === null) return { ...DEFAULT_BOARD_FILTER_PREFS };
  const raw = input as Partial<BoardFilterPrefs>;
  const customFields: Record<string, string[]> = {};
  if (typeof raw.customFields === 'object' && raw.customFields !== null) {
    for (const [key, values] of Object.entries(raw.customFields)) {
      const list = strList(values);
      if (list.length) customFields[key] = list;
    }
  }
  return {
    view: BOARD_VIEW_VALUES.includes(raw.view as BoardView) ? (raw.view as BoardView) : 'all',
    priority: normalizePriority(raw.priority),
    type: uniq(strList(raw.type)),
    tags: uniq(strList(raw.tags)),
    requirements: uniq(strList(raw.requirements)),
    agents: uniq(strList(raw.agents)),
    customFields,
  };
}

/* ------------------------------------------------------------ v1 迁移 */

/**
 * v1 槽的维度 → 过滤 store 的键；status/none 无对应（本来就是列/不过滤）。
 * §19.14：`group` 维不再映射——历史 slot 里的分组值读取即丢弃。
 */
const SLOT_DIM_TO_KEY = {
  requirement: 'requirements',
  agent: 'agents',
  type: 'type',
  tag: 'tags',
  priority: 'priority',
} as const satisfies Record<string, keyof BoardFilterPrefs>;

type StringListKey = 'requirements' | 'agents' | 'type' | 'tags';

interface LegacySlot {
  dim?: unknown;
  values?: unknown;
}

/** 槽值 → store 值词表：`__unassigned__`→`none`、`p2`→2、`tag:x`→`x`；不可译的丢弃。 */
function translateSlotValue(key: StringListKey, value: string): string | null {
  if (key === 'tags') {
    if (value === UNASSIGNED_KEY) return null;
    return value.startsWith('tag:') ? value.slice('tag:'.length) : value;
  }
  if (value === UNASSIGNED_KEY) return 'none';
  return value || null;
}

/** 把一个槽的多选值并进 prefs 的对应维（就地改 target，跨槽去重）。 */
export function mergeSlotValues(
  target: BoardFilterPrefs,
  dim: unknown,
  values: readonly string[],
): void {
  const key =
    typeof dim === 'string'
      ? SLOT_DIM_TO_KEY[dim as keyof typeof SLOT_DIM_TO_KEY]
      : undefined;
  if (!key) return;
  if (key === 'priority') {
    const numbers = values
      .map((value) => (/^p[0-3]$/.test(value) ? Number(value.slice(1)) : null))
      .filter((v): v is number => v !== null);
    target.priority = [...new Set([...target.priority, ...numbers])];
    return;
  }
  const list = values
    .map((value) => translateSlotValue(key, value))
    .filter((v): v is string => v !== null);
  if (list.length) target[key] = uniq([...target[key], ...list]);
}

function isV1Slots(value: object): boolean {
  return 'slotA' in value || 'slotB' in value;
}

/** v1 `{ slotA, slotB }` → v2 扁平。 */
export function migrateV1Slots(value: object): BoardFilterPrefs {
  const prefs: BoardFilterPrefs = { ...DEFAULT_BOARD_FILTER_PREFS, customFields: {} };
  const slotA = (value as { slotA?: LegacySlot }).slotA;
  const slotB = (value as { slotB?: LegacySlot }).slotB;
  for (const slot of [slotA, slotB]) {
    if (!slot || typeof slot !== 'object') continue;
    mergeSlotValues(prefs, slot.dim, strList(slot.values));
  }
  return prefs;
}

/**
 * 旧 `board.grouping` → v2（只读迁移链，§19.14 收窄）：`groupIds/projectIds` 作用域
 * 值读取时丢弃、不回写；泳道时代的 `primary + laneFilter` 仍按槽翻译
 * （`secondary` 在 B13 语义里 values 恒空，忽略）。
 */
export function mergeGroupingPrefs(target: BoardFilterPrefs, input: unknown): void {
  if (typeof input !== 'object' || input === null) return;
  const raw = input as {
    primary?: unknown;
    laneFilter?: unknown;
  };
  if (Array.isArray(raw.laneFilter)) {
    mergeSlotValues(target, raw.primary, strList(raw.laneFilter));
  }
}

/** 任意来源（本地/服务端 JSON）→ v2：自动识别 v1 槽形状。 */
export function coerceBoardFilterPrefs(input: unknown): BoardFilterPrefs {
  if (typeof input !== 'object' || input === null) return { ...DEFAULT_BOARD_FILTER_PREFS };
  if (isV1Slots(input)) return migrateV1Slots(input);
  return normalizeBoardFilterPrefs(input);
}

/* ------------------------------------------------------- store 接线 */

type BoardSlice = BoardFilterPrefs;

const SLICE_KEYS = [
  'view',
  'priority',
  'type',
  'tags',
  'requirements',
  'agents',
  'customFields',
] as const satisfies readonly (keyof FilterState)[];

function boardSliceOf(state: FilterState): BoardSlice {
  const slice = {} as BoardSlice;
  for (const key of SLICE_KEYS) Object.assign(slice, { [key]: state[key] });
  return slice;
}

function serialize(prefs: BoardSlice): string {
  const ordered: unknown[] = [];
  for (const key of SLICE_KEYS) ordered.push(prefs[key]);
  return JSON.stringify(ordered);
}

let lastSerialized = '';
let lastLocalWriteAt = 0;

function writeLocal(prefs: BoardSlice): void {
  lastLocalWriteAt = Date.now();
  lastSerialized = serialize(prefs);
  try {
    window.localStorage.setItem(BOARD_FILTER_LOCAL_KEY, JSON.stringify(prefs));
  } catch {
    // 写失败仅丢偏好，不提示。
  }
  void api.prefs.put(BOARD_FILTER_SERVER_KEY, prefs).catch(() => {
    // 服务端不可用：静默回落 localStorage。
  });
}

/** 外部（服务端水合）落一份偏好到 store，并视为「刚写过」避免订阅器重复 PUT。 */
function applyPrefs(prefs: BoardSlice): void {
  lastSerialized = serialize(prefs);
  useFilterStore.setState(prefs);
}

function readLocalRaw(key: string): unknown {
  try {
    const raw = window.localStorage.getItem(key);
    return raw ? (JSON.parse(raw) as unknown) : null;
  } catch {
    return null;
  }
}

/** 本地读取 + 一次性迁移（v1 槽 / 旧 grouping 都读到才转，转完按 v2 回写）。 */
export function readLocalBoardFilterPrefs(): BoardFilterPrefs {
  const filterRaw = readLocalRaw(BOARD_FILTER_LOCAL_KEY);
  if (filterRaw && typeof filterRaw === 'object' && !isV1Slots(filterRaw)) {
    return normalizeBoardFilterPrefs(filterRaw);
  }
  const groupingRaw = readLocalRaw(GROUPING_LOCAL_KEY);
  const prefs: BoardFilterPrefs = filterRaw ? migrateV1Slots(filterRaw) : { ...DEFAULT_BOARD_FILTER_PREFS, customFields: {} };
  if (groupingRaw) mergeGroupingPrefs(prefs, groupingRaw);
  if (filterRaw || groupingRaw) {
    try {
      window.localStorage.setItem(BOARD_FILTER_LOCAL_KEY, JSON.stringify(prefs));
    } catch {
      // 回写失败不致命：本次会话按迁移值运行。
    }
  }
  return prefs;
}

let prefsHydrated = false;

/** 服务端 → store 的一次性水合；v2 优先，v1/缺失时才动 grouping（防止已清空的旧作用域复活）。 */
export function hydrateServerBoardFilterPrefs(): void {
  if (prefsHydrated || typeof window === 'undefined') return;
  prefsHydrated = true;
  const startedAt = Date.now();
  void Promise.all([
    api.prefs.get(BOARD_FILTER_SERVER_KEY).catch(() => ({ value: null })),
    api.prefs.get(GROUPING_SERVER_KEY).catch(() => ({ value: null })),
  ])
    .then(([filter, grouping]) => {
      // 竞态防护同 B13：GET 在途期间的本地操作不被旧服务端值覆盖。
      if (lastLocalWriteAt > startedAt) return;
      const value: unknown = filter.value;
      let prefs: BoardFilterPrefs | null = null;
      if (value && typeof value === 'object') {
        prefs = isV1Slots(value) ? migrateV1Slots(value) : normalizeBoardFilterPrefs(value);
        if (isV1Slots(value)) mergeGroupingPrefs(prefs, grouping.value);
      } else if (grouping.value && typeof grouping.value === 'object') {
        // 服务端 board.filter 缺失：grouping 并进**当前本地值**（可能刚做过 v1 槽迁移），
        // 不能从默认值重建——否则本地独有维度（如 slotB 的优先级）会被整份顶掉。
        prefs = boardSliceOf(useFilterStore.getState());
        mergeGroupingPrefs(prefs, grouping.value);
      }
      if (!prefs) return;
      applyPrefs(prefs);
      try {
        window.localStorage.setItem(BOARD_FILTER_LOCAL_KEY, JSON.stringify(prefs));
      } catch {
        // 忽略：只影响下次离线打开的初值。
      }
    })
    .catch(() => {
      // 回落 localStorage（store 初值已从本地读）。
    });
}

/* ------------------------------------------------------------ 模块装配 */

if (typeof window !== 'undefined') {
  // 初值：本地（含一次性迁移回写）先落 store，再挂持久订阅，最后服务端异步水合覆盖。
  applyPrefs(readLocalBoardFilterPrefs());
  useFilterStore.subscribe((state) => {
    const slice = boardSliceOf(state);
    if (serialize(slice) === lastSerialized) return;
    writeLocal(slice);
  });
  hydrateServerBoardFilterPrefs();
}
