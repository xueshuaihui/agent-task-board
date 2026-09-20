import { create } from 'zustand';
import { api } from '@/api';

/**
 * v0.0.4 W5 §6.4.9「设置 / 视图」的偏好真值 + §6.4.2 三视图的显示模式。
 *
 * 持久化与 `board.grouping` 同一套接缝（PRD 20.7 存量 prefs REST，不新增后端接口）：
 * localStorage 先写兜底，`PUT /prefs/board.view` 尽力而为；启动时 `GET /prefs/board.view`
 * 一次性水合。设置 Tab 与流程图工具栏读写同一个 store，改值即时生效。
 *
 * 各字段口径（§6.4.9 表格 + §13 验收 74/75）：
 * - `perfSmallLimit` / `perfLargeLimit`：性能档位边界（默认 50 / 200），
 *   小档全渲染，中档开虚拟化（onlyRenderVisibleElements），大档提示筛选；
 * - `simplifyThreshold`：节点简化阈值（默认 100），节点数 ≥ 该值时节点退化为
 *   ID+标题的精简卡；
 * - `zoomMin` / `zoomMax`：滚轮缩放范围百分比（默认 50–200）；
 * - `flowDirection`：流程图默认方向（§13 待确认 4：从上到下）；
 * - `highlightCritical` / `highlightBlocked`：关键路径 / 阻塞链高亮默认开关；
 * - `persistLayout`：布局是否持久化（开时拖过的节点位置写 `board.flow.layout`）；
 * - `mode`：看板页显示模式（看板 / 流程图；「列表」是独立路由，点击即跳转，不持久化）。
 *   §6.4.9「看板保留视图选择记忆到用户偏好」——这一项就落同一个 prefs key。
 */

export type FlowDirection = 'TB' | 'LR';
export type BoardDisplayMode = 'board' | 'flow';

export interface ViewPrefs {
  mode: BoardDisplayMode;
  perfSmallLimit: number;
  perfLargeLimit: number;
  simplifyThreshold: number;
  zoomMinPercent: number;
  zoomMaxPercent: number;
  flowDirection: FlowDirection;
  highlightCritical: boolean;
  highlightBlocked: boolean;
  persistLayout: boolean;
}

export const DEFAULT_VIEW_PREFS: ViewPrefs = {
  mode: 'board',
  perfSmallLimit: 50,
  perfLargeLimit: 200,
  simplifyThreshold: 100,
  zoomMinPercent: 50,
  zoomMaxPercent: 200,
  flowDirection: 'TB',
  highlightCritical: true,
  highlightBlocked: true,
  persistLayout: true,
};

export const VIEW_PREFS_LOCAL_KEY = 'atb.board.view';
export const VIEW_PREFS_SERVER_KEY = 'board.view';
/** 节点坐标持久化（§6.4.9「布局是否持久化」），单独一个 prefs key 避免视图参数改动连带位置。 */
export const FLOW_LAYOUT_LOCAL_KEY = 'atb.board.flow.layout';
export const FLOW_LAYOUT_SERVER_KEY = 'board.flow.layout';

export type FlowLayout = Record<string, { x: number; y: number }>;

const clamp = (value: number, min: number, max: number): number =>
  Number.isFinite(value) ? Math.min(max, Math.max(min, value)) : min;

/** 任意来源（服务端水合 / localStorage 旧值）的 JSON 收敛到合法形状。 */
export function normalizeViewPrefs(input: unknown): ViewPrefs {
  if (typeof input !== 'object' || input === null) return DEFAULT_VIEW_PREFS;
  const raw = input as Partial<ViewPrefs>;
  const perfSmallLimit = clamp(Number(raw.perfSmallLimit ?? DEFAULT_VIEW_PREFS.perfSmallLimit), 10, 500);
  const perfLargeLimit = Math.max(
    clamp(Number(raw.perfLargeLimit ?? DEFAULT_VIEW_PREFS.perfLargeLimit), 10, 2000),
    perfSmallLimit + 1,
  );
  const zoomMinPercent = clamp(Number(raw.zoomMinPercent ?? DEFAULT_VIEW_PREFS.zoomMinPercent), 10, 100);
  const zoomMaxPercent = Math.max(
    clamp(Number(raw.zoomMaxPercent ?? DEFAULT_VIEW_PREFS.zoomMaxPercent), 100, 400),
    zoomMinPercent + 25,
  );
  return {
    mode: raw.mode === 'flow' ? 'flow' : 'board',
    perfSmallLimit,
    perfLargeLimit,
    simplifyThreshold: clamp(Number(raw.simplifyThreshold ?? DEFAULT_VIEW_PREFS.simplifyThreshold), 10, perfLargeLimit),
    zoomMinPercent,
    zoomMaxPercent,
    flowDirection: raw.flowDirection === 'LR' ? 'LR' : 'TB',
    highlightCritical: raw.highlightCritical !== false,
    highlightBlocked: raw.highlightBlocked !== false,
    persistLayout: raw.persistLayout !== false,
  };
}

function readLocalViewPrefs(): ViewPrefs {
  try {
    const raw = window.localStorage.getItem(VIEW_PREFS_LOCAL_KEY);
    return raw ? normalizeViewPrefs(JSON.parse(raw)) : DEFAULT_VIEW_PREFS;
  } catch {
    return DEFAULT_VIEW_PREFS;
  }
}

export function writeViewPrefs(prefs: ViewPrefs): void {
  try {
    window.localStorage.setItem(VIEW_PREFS_LOCAL_KEY, JSON.stringify(prefs));
  } catch {
    /* 隐私模式：只丢偏好持久化，不影响本次会话。 */
  }
  void api.prefs.put(VIEW_PREFS_SERVER_KEY, prefs).catch(() => {
    /* 服务端不可用：静默回落 localStorage（上面已写）。 */
  });
}

let viewPrefsHydrated = false;

/** 模块级一次性水合：GET /prefs/board.view 命中即覆盖 store（失败保持本地初值）。 */
export function hydrateViewPrefs(): void {
  if (viewPrefsHydrated || typeof window === 'undefined') return;
  viewPrefsHydrated = true;
  void api.prefs
    .get(VIEW_PREFS_SERVER_KEY)
    .then((result) => {
      const prefs = normalizeViewPrefs(result.value);
      // 服务端没存过的键 http 也会回 value:null——normalize 会给出全默认值，
      // 此时不要用默认值盖掉用户本地刚写、但 PUT 没成功的偏好。
      if (!result.value || typeof result.value !== 'object') return;
      useViewPrefsStore.setState(prefs);
      try {
        window.localStorage.setItem(VIEW_PREFS_LOCAL_KEY, JSON.stringify(prefs));
      } catch {
        /* 同上，忽略。 */
      }
    })
    .catch(() => {
      /* 回落 localStorage（store 初值已从本地读）。 */
    });
}

export interface ViewPrefsState extends ViewPrefs {
  update: (patch: Partial<ViewPrefs>) => void;
  setMode: (mode: BoardDisplayMode) => void;
  reset: () => void;
}

export const useViewPrefsStore = create<ViewPrefsState>((set) => ({
  ...readLocalViewPrefs(),
  update: (patch) =>
    set((state) => {
      const next = normalizeViewPrefs({ ...state, ...patch });
      writeViewPrefs(next);
      return next;
    }),
  setMode: (mode) =>
    set((state) => {
      const next: ViewPrefs = { ...state, mode };
      writeViewPrefs(next);
      return { mode };
    }),
  reset: () => {
    writeViewPrefs(DEFAULT_VIEW_PREFS);
    return set({ ...DEFAULT_VIEW_PREFS });
  },
}));

hydrateViewPrefs();

/* ------------------------------------------------------- 布局（节点坐标）持久化 */

function readLocalFlowLayout(): FlowLayout {
  try {
    const raw = window.localStorage.getItem(FLOW_LAYOUT_LOCAL_KEY);
    const parsed: unknown = raw ? JSON.parse(raw) : {};
    if (typeof parsed !== 'object' || parsed === null) return {};
    const result: FlowLayout = {};
    for (const [id, pos] of Object.entries(parsed as Record<string, unknown>)) {
      if (typeof pos === 'object' && pos !== null) {
        const { x, y } = pos as { x?: unknown; y?: unknown };
        if (typeof x === 'number' && typeof y === 'number') result[id] = { x, y };
      }
    }
    return result;
  } catch {
    return {};
  }
}

let flowLayoutHydrated = false;
let flowLayout: FlowLayout = typeof window === 'undefined' ? {} : readLocalFlowLayout();

/** 一次性水合布局坐标；返回 Promise 供画布首帧等待，避免默认布局抢跑覆盖已存位置。 */
export function hydrateFlowLayout(): Promise<FlowLayout> {
  if (typeof window === 'undefined') return Promise.resolve({});
  if (flowLayoutHydrated) return Promise.resolve(flowLayout);
  flowLayoutHydrated = true;
  return api.prefs
    .get(FLOW_LAYOUT_SERVER_KEY)
    .then((result) => {
      const value = result.value;
      if (value && typeof value === 'object') {
        flowLayout = readLocalFlowLayout(); // 先保本地写入（可能比服务端新），再并入服务端键
        for (const [id, pos] of Object.entries(value as Record<string, unknown>)) {
          if (typeof pos === 'object' && pos !== null) {
            const { x, y } = pos as { x?: unknown; y?: unknown };
            if (typeof x === 'number' && typeof y === 'number' && !(id in flowLayout)) flowLayout[id] = { x, y };
          }
        }
      }
      return flowLayout;
    })
    .catch(() => flowLayout);
}

export function getFlowLayout(): FlowLayout {
  return flowLayout;
}

/** 位置整体覆盖写：localStorage 先写，prefs 尽力而为（与视图参数同一条接缝）。 */
export function writeFlowLayout(next: FlowLayout): void {
  flowLayout = next;
  try {
    window.localStorage.setItem(FLOW_LAYOUT_LOCAL_KEY, JSON.stringify(next));
  } catch {
    /* 忽略。 */
  }
  void api.prefs.put(FLOW_LAYOUT_SERVER_KEY, next).catch(() => {
    /* 忽略。 */
  });
}

/** 清空已存布局（设置页「重置」与 >200 筛选提示后重排都用它）。 */
export function clearFlowLayout(): void {
  writeFlowLayout({});
}
