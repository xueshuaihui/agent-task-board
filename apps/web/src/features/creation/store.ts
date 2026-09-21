import { create } from 'zustand';
import type { CreationRequestStatus, CreationRequestView } from '@/api/types';

/**
 * v0.0.4 W8 §8.7 轻确认卡片栈：右下角浮层的本地状态。
 *
 * 为什么不走 react-query 缓存：卡片是「一条 WS 事件 = 一张卡」的会话式浮层，
 * 服务端待决请求驻内存、GET 列表还混着近期终结项，用查询缓存就得自己拼 diff；
 * 而 PRD 要的正是「卡片出现 → 用户点掉 → 卡片就地转终态」的本地时间线。
 * 所以 WS 载荷直接进这份 store，GET 列表只在断线重连时补一次（见 queries.ts）。
 *
 * 终态（created/edited/cancelled/timeout）不再被后续 view 覆回 pending：
 * 服务端决策后不会再广播终结（PRD §16.3 明确不私加 resolved 事件），
 * 卡片归宿只由「本地倒计时到期」与「decision 回包/409」两条路径推进。
 */

/** §8.6 撤销：created 之后本地再挂一层「已撤销」标记（服务端状态词表里没有这一项）。 */
export interface CreationCard extends CreationRequestView {
  undone?: boolean;
  /** 409 `CREATION_REQUEST_RESOLVED` 就地收口时的说明文案（区分「已被处理」与「已超时」）。 */
  resolvedNote?: string;
}

const TERMINAL: ReadonlySet<CreationRequestStatus> = new Set([
  'created',
  'edited',
  'cancelled',
  'timeout',
]);

export function isTerminalStatus(status: CreationRequestStatus): boolean {
  return TERMINAL.has(status);
}

/** 同屏最多留几张卡：超过就把最旧的**待决**卡挤掉，终态卡留给用户自己关。 */
const MAX_PENDING_CARDS = 4;

interface CreationState {
  /** 按到达顺序（最新在末尾），右下角自下向上堆叠。 */
  cards: CreationCard[];
  upsert: (view: CreationRequestView) => void;
  upsertMany: (views: readonly CreationRequestView[]) => void;
  dismiss: (requestId: string) => void;
  markUndone: (requestId: string) => void;
  /** 本地倒计时/宽限到期：pending → timeout（不创建，§8.3）。 */
  expireLocally: (requestId: string) => void;
  /**
   * decision 回 409 `CREATION_REQUEST_RESOLVED`（§8.7 r3：过 expires_at+5s 宽限即拒收）
   * 时的就地收口：卡片不再给动作，只留一行归宿说明。
   */
  settle: (requestId: string, status: CreationRequestStatus, note: string) => void;
}

function merge(prev: CreationCard | undefined, view: CreationRequestView): CreationCard {
  if (!prev) return { ...view };
  // 终态不回退；已经点过撤销的卡片也不被重取的列表覆写。
  if (isTerminalStatus(prev.status) && !isTerminalStatus(view.status)) return prev;
  return { ...prev, ...view, undone: prev.undone, resolvedNote: prev.resolvedNote };
}

export const useCreationStore = create<CreationState>((set) => ({
  cards: [],

  upsert: (view) =>
    set((state) => {
      const index = state.cards.findIndex((card) => card.request_id === view.request_id);
      const cards = [...state.cards];
      if (index >= 0) cards[index] = merge(cards[index], view);
      else cards.push({ ...view });
      return { cards: capPending(cards) };
    }),

  upsertMany: (views) =>
    set((state) => {
      if (views.length === 0) return state;
      const cards = [...state.cards];
      for (const view of views) {
        const index = cards.findIndex((card) => card.request_id === view.request_id);
        if (index >= 0) cards[index] = merge(cards[index], view);
        else cards.push({ ...view });
      }
      return { cards: capPending(cards) };
    }),

  dismiss: (requestId) =>
    set((state) => ({ cards: state.cards.filter((card) => card.request_id !== requestId) })),

  markUndone: (requestId) =>
    set((state) => ({
      cards: state.cards.map((card) =>
        card.request_id === requestId ? { ...card, undone: true } : card,
      ),
    })),

  expireLocally: (requestId) =>
    set((state) => ({
      cards: state.cards.map((card) =>
        card.request_id === requestId && card.status === 'pending'
          ? { ...card, status: 'timeout', task_id: null }
          : card,
      ),
    })),

  settle: (requestId, status, note) =>
    set((state) => ({
      cards: state.cards.map((card) =>
        card.request_id === requestId
          ? { ...card, status, resolvedNote: note }
          : card,
      ),
    })),
}));

/** 待决卡封顶：挤掉的是最旧的 pending 卡（它的服务端定时器照样会收口，不会漏决策）。 */
function capPending(cards: CreationCard[]): CreationCard[] {
  const pending = cards.filter((card) => card.status === 'pending');
  if (pending.length <= MAX_PENDING_CARDS) return cards;
  const drop = pending.slice(0, pending.length - MAX_PENDING_CARDS).map((card) => card.request_id);
  return cards.filter((card) => !drop.includes(card.request_id));
}

/* ------------------------------------------------------------------ */
/* §8.6 direct/silent 直建 5 秒撤销浮层的栈（原住在 agent-undo-stack.tsx， */
/* 迁到这里与渲染分离，纯函数可单测）。                                   */
/* ------------------------------------------------------------------ */

/** §8.6「创建后 5 秒内可撤销」的窗口长度，与 creation-card.tsx 同一常量口径。 */
export const UNDO_WINDOW_MS = 5_000;
/** 撤销成功后「已撤销」回显的停留时长，让用户确认结果。 */
export const DONE_LINGER_MS = 3_000;

export interface AgentCreatedEntry {
  taskId: string;
  /** 事件到达时刻：撤销窗起点（本地时钟，与创建卡片 createdAtRef 同一做法）。 */
  createdAtMs: number;
  undone: boolean;
  undoneAtMs: number | null;
}

/**
 * 单条撤销入口的剩余窗口（ms）。
 *
 * v0.0.4 补验缺陷：倒计时**必须以渲染时刻 `now` 直接相减**，不得用组件里
 * 挂载时初始化的旧 tick——entries 从 0→1 时新条目刚 push，旧 tick 远早于
 * createdAtMs，msLeft 会虚高到 60s+（实测抓到「撤销 63s」）。
 * tick/interval 只作重渲染驱动，数值一律出自这份纯函数。
 */
export function agentUndoMsLeft(
  entry: Pick<AgentCreatedEntry, 'createdAtMs' | 'undone'>,
  now: number,
): number {
  if (entry.undone) return 0;
  return Math.max(0, UNDO_WINDOW_MS - Math.max(0, now - entry.createdAtMs));
}

/** 「撤销 Ns」按钮文案：msLeft ≤ 5000 恒成立，首帧至多「撤销 5s」。 */
export function agentUndoLabel(entry: Pick<AgentCreatedEntry, 'createdAtMs' | 'undone'>, now: number): string {
  return `撤销 ${Math.ceil(agentUndoMsLeft(entry, now) / 1000)}s`;
}

interface AgentUndoState {
  entries: AgentCreatedEntry[];
  push: (taskId: string) => void;
  markUndone: (taskId: string) => void;
  remove: (taskId: string) => void;
  /** 定时器每跳调用：超窗未撤销的消失、已撤销过留痕期的消失。 */
  prune: (now: number) => void;
}

export const useAgentUndoStore = create<AgentUndoState>((set) => ({
  entries: [],
  push: (taskId) =>
    set((state) =>
      state.entries.some((entry) => entry.taskId === taskId)
        ? state
        : {
            entries: [
              ...state.entries,
              { taskId, createdAtMs: Date.now(), undone: false, undoneAtMs: null },
            ],
          },
    ),
  markUndone: (taskId) =>
    set((state) => ({
      entries: state.entries.map((entry) =>
        entry.taskId === taskId ? { ...entry, undone: true, undoneAtMs: Date.now() } : entry,
      ),
    })),
  remove: (taskId) =>
    set((state) => ({ entries: state.entries.filter((entry) => entry.taskId !== taskId) })),
  prune: (now) =>
    set((state) => {
      const entries = state.entries.filter((entry) =>
        entry.undone
          ? (entry.undoneAtMs ?? now) + DONE_LINGER_MS > now
          : now - entry.createdAtMs < UNDO_WINDOW_MS,
      );
      return entries.length === state.entries.length ? state : { entries };
    }),
}));
