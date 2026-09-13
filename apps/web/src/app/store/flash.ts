import { create } from 'zustand';

/**
 * 10.1 状态变更高亮：WS 事件是全局的，卡片是各列渲染的，所以「谁刚变过」放在这一处，
 * 由 `src/ws/invalidate.ts` 写入、看板卡片与列表行读取，避免每个 feature 自己监听事件。
 * 800ms 后自动摘掉（与 animate-status-flash 的时长一致），不保留历史。
 */
interface FlashState {
  /** taskId -> 触发时间戳 */
  marked: Record<string, number>;
  mark: (ids: (string | null | undefined)[]) => void;
  isFlashed: (id: string) => boolean;
}

const FLASH_MS = 800;

export const useFlashStore = create<FlashState>((set, get) => ({
  marked: {},
  mark: (ids) => {
    const now = Date.now();
    const fresh = Object.fromEntries(
      ids.filter((id): id is string => typeof id === 'string' && id.length > 0).map((id) => [id, now]),
    );
    if (Object.keys(fresh).length === 0) return;
    set((state) => ({ marked: { ...state.marked, ...fresh } }));
    for (const id of Object.keys(fresh)) {
      // 逐个定时器：同一任务连续变更时后一次会覆盖时间戳，清掉时再判一次时间防止误删新标记。
      setTimeout(() => {
        const stamp = get().marked[id];
        if (stamp !== undefined && now - stamp < FLASH_MS * 2) {
          set((state) => {
            if (Date.now() - (state.marked[id] ?? 0) < FLASH_MS) return state;
            const next = { ...state.marked };
            delete next[id];
            return { marked: next };
          });
        }
      }, FLASH_MS);
    }
  },
  isFlashed: (id) => get().marked[id] !== undefined,
}));

/** 订阅式读取（卡片组件用）：只在被标记/取消标记时重渲染。 */
export function useIsFlashed(id: string): boolean {
  return useFlashStore((state) => state.marked[id] !== undefined);
}
