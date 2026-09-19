import { http } from '@/api';
import type {
  MarketCommentDto,
  MarketFeedbackDto,
  MarketListingDetail,
  MarketListingSummary,
  MarketListQuery,
  MarketSubscriptionDto,
} from './types';

/**
 * 市场资源 API 封装（契约：apps/api/src/market/market.controller.ts，22 个端点）。
 * 与 skills/api.ts 同一条接缝约定：不挂进 src/api 的聚合对象，独立导出 marketApi。
 * 鉴权、/api/v1 前缀、错误归一全部复用 http（src/api/client.ts）。
 */
function enc(id: string): string {
  return encodeURIComponent(id);
}

export const marketApi = {
  // 浏览 / 我的
  list: (query?: MarketListQuery) => http.get<{ items: MarketListingSummary[]; total: number }>('/market/listings', query),
  subscriptions: () => http.get<{ items: MarketSubscriptionDto[] }>('/market/subscriptions'),
  myPublishes: () => http.get<{ items: MarketListingSummary[] }>('/market/me/publishes'),
  myFeedbacks: () => http.get<{ items: MarketFeedbackDto[] }>('/market/me/feedbacks'),
  myFavorites: () => http.get<{ items: MarketListingSummary[] }>('/market/me/favorites'),
  detail: (id: string) => http.get<MarketListingDetail>(`/market/listings/${enc(id)}`),

  // 发布 / 审核 / 下线 / 新版本
  publish: (body: { skill_id: string; visibility: 'public' | 'private'; category: string; license?: string; compatible_clients?: string[] }) =>
    http.post<MarketListingDetail>('/market/publish', body),
  review: (id: string, body: { action: 'approve' | 'reject'; reason?: string }) =>
    http.post<MarketListingDetail>(`/market/listings/${enc(id)}/review`, body),
  delist: (id: string) => http.post<MarketListingDetail>(`/market/listings/${enc(id)}/delist`, {}),
  publishVersion: (id: string, skillId: string) =>
    http.post<MarketListingDetail>(`/market/listings/${enc(id)}/publish-version`, { skill_id: skillId }),

  // 订阅
  subscribe: (id: string) => http.post<MarketSubscriptionDto>(`/market/listings/${enc(id)}/subscribe`, {}),
  pullUpdate: (id: string) => http.post<MarketSubscriptionDto>(`/market/listings/${enc(id)}/update`, {}),
  unsubscribe: (id: string) => http.del<{ ok: true }>(`/market/listings/${enc(id)}/subscribe`),

  // 评分 / 评论 / 收藏 / 举报
  rate: (id: string, score: number) => http.post<MarketListingDetail>(`/market/listings/${enc(id)}/rating`, { score }),
  comment: (id: string, content: string) =>
    http.post<{ items: MarketCommentDto[]; total: number }>(`/market/listings/${enc(id)}/comments`, { content }),
  deleteComment: (commentId: string) => http.del<{ ok: true }>(`/market/comments/${enc(commentId)}`),
  toggleFavorite: (id: string) => http.post<{ favorited: boolean }>(`/market/listings/${enc(id)}/favorite`, {}),

  // 举报 / 反馈闭环
  report: (id: string, reason: string) => http.post<{ ok: true }>(`/market/listings/${enc(id)}/report`, { reason }),
  createFeedback: (id: string, body: { title: string; content: string }) =>
    http.post<MarketFeedbackDto>(`/market/listings/${enc(id)}/feedback`, body),
  respondFeedback: (feedbackId: string, body: { response: string; resolution: 'fixed' | 'wontfix' }) =>
    http.post<MarketFeedbackDto>(`/market/feedbacks/${enc(feedbackId)}/respond`, body),
  verifyFeedback: (feedbackId: string, confirmed: boolean) =>
    http.post<MarketFeedbackDto>(`/market/feedbacks/${enc(feedbackId)}/verify`, { confirmed }),
};
