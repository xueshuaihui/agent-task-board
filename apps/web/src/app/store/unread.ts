import { create } from 'zustand';

/**
 * 未读通知数：顶栏铃铛与托盘角标同源（原型 2.3 末段）。
 * 三个写入点、一个读点：
 * 1) `GET /board` 的 `unread_notifications`；
 * 2) `GET /notifications` 的 `unread_count`；
 * 3) WS `notification.created` 的 `unread_count`（服务端算好带上，无需回查）。
 * 故意不做成 react-query 缓存：WS 推来的是**计数**而不是列表，为它发一次 list 请求是把
 * 服务端已经算好的东西再算一遍，还会让铃铛在离线时闪回 0。
 */
interface UnreadState {
  count: number;
  set: (count: number) => void;
  bump: (delta: number) => void;
}

export const useUnreadStore = create<UnreadState>((set) => ({
  count: 0,
  set: (count) => set({ count: Number.isFinite(count) ? Math.max(0, count) : 0 }),
  bump: (delta) => set((state) => ({ count: Math.max(0, state.count + delta) })),
}));

/** 2.2：角标 0 时不渲染徽标本体，>99 显示 `99+`。 */
export function badgeText(count: number): string | null {
  if (count <= 0) return null;
  return count > 99 ? '99+' : String(count);
}
