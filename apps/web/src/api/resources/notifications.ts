import { http } from '../client';
import type { MarkReadInput, NotificationListResult } from '../types';

/** 6.7 通知。阶段一只用得到未读数（原型 2.2）；通知面板列表属阶段二（10.2、lib/phase.ts）。 */
export const notificationsApi = {
  /** `?unread=true` → `{items[], unread_count}`；`unread_count` 同时供托盘角标同源使用。 */
  list: (params?: { unread?: boolean }) =>
    http.get<NotificationListResult>('/notifications', {
      unread: params?.unread ? 'true' : undefined,
    }),

  markRead: (body: MarkReadInput) => http.post<{ updated: number }>('/notifications/read', body),

  /**
   * 顶栏铃铛点击后只清「待审核」那一类未读（2.2：落地即把对应通知标已读、计数回落）。
   * 13 章的 mark-read 只有 `ids` 与 `all` 两种粒度、没有按 kind 过滤的入参，
   * 所以先拉未读列表、挑出 `review_pending` 的 id 再标——两次请求，但不会误清其他四类。
   */
  markReviewPendingRead: async (): Promise<number> => {
    const list = await notificationsApi.list({ unread: true });
    const ids = list.items.filter((item) => item.kind === 'review_pending').map((item) => item.id);
    if (ids.length === 0) return 0;
    const { updated } = await notificationsApi.markRead({ ids });
    return updated;
  },
};
