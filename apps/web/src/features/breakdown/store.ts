import { create } from 'zustand';

/**
 * 拆解创建页的宿主状态（§7.3「覆盖层，不是独立路由」）。
 *
 * 与 `features/requirements/requirement-store.ts` 同一模式：入口（WS 自动进入、
 * 浮标按钮、切换器）都通过 `useBreakdownOverlayStore.getState()` 操作，
 * 组件只在 `app/overlay-slot.tsx` 挂一次 `<BreakdownOverlayHost />`。
 */
interface BreakdownOverlayState {
  /** 覆盖层是否打开。 */
  open: boolean;
  /** 当前查看的会话 id；null = 由宿主回落到「最新会话」。 */
  activeId: string | null;
  show: (sessionId?: string) => void;
  hide: () => void;
  setActive: (sessionId: string) => void;
}

export const useBreakdownOverlayStore = create<BreakdownOverlayState>((set) => ({
  open: false,
  activeId: null,
  show: (sessionId) =>
    set((state) => ({ open: true, activeId: sessionId ?? state.activeId })),
  hide: () => set({ open: false }),
  setActive: (sessionId) => set({ activeId: sessionId }),
}));
