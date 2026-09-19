import { z } from 'zod';
import { SKILL_TYPES, skillContentSchema, type SkillContent, type SkillMcpDependency } from '../skills/skills.dto';

/** 9.1/12.1 市场分类词表（原型 12.1 的分类条）。 */
export const MARKET_CATEGORIES = ['开发流程', '质量保障', '测试', '文档', '部署', '重构', '效率', '写作', '安全', '数据', '运维'] as const;

/** 9.3 发布状态机：UNLISTED=私有未发布，PENDING_REVIEW=审核中，PUBLISHED=已发布。 */
export const MARKET_LISTING_STATUSES = [
  'PENDING_REVIEW',
  'PUBLISHED',
  'REJECTED',
  'DELISTED',
  'UNLISTED',
] as const;
export type MarketListingStatus = (typeof MARKET_LISTING_STATUSES)[number];

/** 14.2 我的发布里的状态文案，服务层统一给出，避免前端措辞分叉。 */
export const MARKET_STATUS_LABEL: Record<MarketListingStatus, string> = {
  PENDING_REVIEW: '审核中',
  PUBLISHED: '已发布',
  REJECTED: '已拒绝',
  DELISTED: '已下线',
  UNLISTED: '未发布',
};

export const MARKET_SUBSCRIPTION_STATUSES = ['SYNCED', 'HAS_UPDATE', 'DELISTED'] as const;
export type MarketSubscriptionStatus = (typeof MARKET_SUBSCRIPTION_STATUSES)[number];

export const MARKET_FEEDBACK_STATUSES = [
  'PENDING',
  'FIXED_PENDING_VERIFY',
  'RESOLVED',
  'WONTFIX',
] as const;
export type MarketFeedbackStatus = (typeof MARKET_FEEDBACK_STATUSES)[number];

// ---------------------------------------------------------------- 入参

export const marketListQuerySchema = z.object({
  keyword: z.string().trim().max(100).optional(),
  category: z.string().trim().max(50).optional(),
  type: z.enum(SKILL_TYPES).optional(),
  min_rating: z.coerce.number().min(0).max(5).optional(),
  sort: z.enum(['hot', 'new', 'rating', 'downloads']).default('hot'),
  compatible_client: z.string().trim().max(50).optional(),
});
export type MarketListQuery = z.infer<typeof marketListQuerySchema>;

export const marketPublishSchema = z.object({
  skill_id: z.string().min(1).max(64),
  visibility: z.enum(['public', 'private']),
  category: z.string().trim().min(1).max(50),
  license: z.string().trim().max(100).default(''),
  compatible_clients: z.array(z.string().trim().min(1).max(50)).max(20).default([]),
});
export type MarketPublishInput = z.infer<typeof marketPublishSchema>;

export const marketReviewSchema = z.object({
  action: z.enum(['approve', 'reject']),
  reason: z.string().trim().max(500).default(''),
});
export type MarketReviewInput = z.infer<typeof marketReviewSchema>;

export const marketPublishVersionSchema = z.object({
  skill_id: z.string().min(1).max(64),
});
export type MarketPublishVersionInput = z.infer<typeof marketPublishVersionSchema>;

export const marketRatingSchema = z.object({
  score: z.number().int().min(1).max(5),
});
export type MarketRatingInput = z.infer<typeof marketRatingSchema>;

export const marketCommentSchema = z.object({
  content: z.string().trim().min(1).max(500),
});
export type MarketCommentInput = z.infer<typeof marketCommentSchema>;

export const marketReportSchema = z.object({
  reason: z.string().trim().min(1).max(500),
});
export type MarketReportInput = z.infer<typeof marketReportSchema>;

export const marketFeedbackSchema = z.object({
  title: z.string().trim().min(1).max(100),
  content: z.string().trim().min(1).max(2000),
});
export type MarketFeedbackInput = z.infer<typeof marketFeedbackSchema>;

export const marketFeedbackRespondSchema = z.object({
  response: z.string().trim().min(1).max(2000),
  resolution: z.enum(['fixed', 'wontfix']),
});
export type MarketFeedbackRespondInput = z.infer<typeof marketFeedbackRespondSchema>;

export const marketFeedbackVerifySchema = z.object({
  confirmed: z.boolean(),
});
export type MarketFeedbackVerifyInput = z.infer<typeof marketFeedbackVerifySchema>;

// ---------------------------------------------------------------- 读取模型

export interface MarketListingSummary {
  id: string;
  slug: string;
  name: string;
  description: string;
  category: string;
  tags: string[];
  type: string;
  source: 'builtin' | 'published';
  license: string;
  compatible_clients: string[];
  current_version: string;
  publisher_account_id: string | null;
  publisher_name: string;
  status: MarketListingStatus;
  status_label: string;
  review_note: string;
  rating_avg: number;
  rating_count: number;
  subscriber_count: number;
  view_count: number;
  published_at: string | null;
  created_at: string | null;
}

export interface MarketCommentDto {
  id: string;
  account_id: string;
  author_name: string;
  content: string;
  created_at: string | null;
}

export interface MarketListingDetail extends MarketListingSummary {
  content: SkillContent;
  mcp_dependencies: SkillMcpDependency[];
  comments: { items: MarketCommentDto[]; total: number };
  rating: { avg: number; count: number };
  my: { subscribed: boolean; favorited: boolean; rating: number | null };
}

export interface MarketSubscriptionDto {
  listing_id: string;
  listing_name: string;
  listing_slug: string;
  listing_status: MarketListingStatus;
  source: 'builtin' | 'published';
  status: MarketSubscriptionStatus;
  snapshot_version: string;
  latest_version: string;
  skill_id: string | null;
  created_at: string | null;
}

export interface MarketPublishDto extends MarketListingSummary {
  subscriber_count: number;
}

export interface MarketFeedbackDto {
  id: string;
  listing_id: string;
  listing_name: string;
  account_id: string;
  title: string;
  content: string;
  status: MarketFeedbackStatus;
  author_response: string;
  created_at: string | null;
  responded_at: string | null;
}

export { skillContentSchema };
