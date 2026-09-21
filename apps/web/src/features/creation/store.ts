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
