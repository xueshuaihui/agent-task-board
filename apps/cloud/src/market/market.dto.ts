import { z } from 'zod';

/** 技能类型词表，与 apps/api 的 SKILL_TYPES 一致（契约互通）。 */
export const SKILL_TYPES = ['prompt', 'steps', 'flow', 'script', 'knowledge', 'composite', 'workflow'] as const;
export type SkillType = (typeof SKILL_TYPES)[number];

/** 市场分类词表（与 apps/api market.dto.ts 一致）。 */
export const MARKET_CATEGORIES = ['开发流程', '质量保障', '测试', '文档', '部署', '重构', '效率', '写作', '安全', '数据', '运维'] as const;

export const LISTING_STATUSES = ['PUBLISHED', 'DELISTED'] as const;
export type ListingStatus = (typeof LISTING_STATUSES)[number];

export const SUBSCRIPTION_STATUSES = ['SYNCED', 'HAS_UPDATE', 'DELISTED'] as const;
export type SubscriptionStatus = (typeof SUBSCRIPTION_STATUSES)[number];

export const FEEDBACK_STATUSES = ['PENDING', 'FIXED_PENDING_VERIFY', 'RESOLVED', 'WONTFIX'] as const;
export type FeedbackStatus = (typeof FEEDBACK_STATUSES)[number];

// ---------------------------------------------------------------- content（宽松校验：内容是载荷，业务字段必须无损往返）

const blockSchema = z.looseObject({
  id: z.string().min(1).max(64),
  kind: z.string().min(1).max(32),
});

export const skillContentSchema = z.looseObject({
  entryBlockId: z.string().max(64).nullable().optional(),
  blocks: z.array(blockSchema).default([]),
});
export type SkillContent = z.infer<typeof skillContentSchema>;

export const mcpDependencySchema = z.looseObject({
  name: z.string().min(1).max(100),
});
export type SkillMcpDependency = z.infer<typeof mcpDependencySchema>;

// ---------------------------------------------------------------- 入参

export const marketListQuerySchema = z.object({
  keyword: z.string().trim().max(100).optional(),
  category: z.string().trim().max(50).optional(),
  type: z.enum(SKILL_TYPES).optional(),
  sort: z.enum(['hot', 'new', 'rating']).default('hot'),
});
export type MarketListQuery = z.infer<typeof marketListQuerySchema>;

export const marketPublishSchema = z.object({
  name: z.string().trim().min(1).max(64),
  slug: z
    .string()
    .trim()
    .regex(/^[a-z0-9](-?[a-z0-9]){0,63}$/, 'slug 需为小写字母/数字/连字符')
    .optional(),
  description: z.string().trim().min(1).max(2000),
  category: z.string().trim().min(1).max(50),
  tags: z.array(z.string().trim().min(1).max(30)).max(20).default([]),
  type: z.enum(SKILL_TYPES),
  license: z.string().trim().max(100).default(''),
  compatible_clients: z.array(z.string().trim().min(1).max(50)).max(20).default([]),
  content: skillContentSchema,
  mcp_dependencies: z.array(mcpDependencySchema).max(20).default([]),
  version: z.string().trim().min(1).max(32),
});
export type MarketPublishInput = z.infer<typeof marketPublishSchema>;

export const marketPublishVersionSchema = z.object({
  content: skillContentSchema,
  version: z.string().trim().min(1).max(32),
  changelog: z.string().trim().max(2000).default(''),
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
  license: string;
  compatible_clients: string[];
  mcp_dependencies: SkillMcpDependency[];
  current_version: string;
  publisher_account_id: string | null;
  publisher_name: string;
  status: ListingStatus;
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
  comments: { items: MarketCommentDto[]; total: number };
  rating: { avg: number; count: number };
}

export interface MarketSubscriptionDto {
  listing_id: string;
  listing_name: string;
  listing_slug: string;
  listing_status: ListingStatus;
  status: SubscriptionStatus;
  snapshot_version: string;
  latest_version: string;
  created_at: string | null;
}

export interface MarketFeedbackDto {
  id: string;
  listing_id: string;
  listing_name: string;
  account_id: string;
  title: string;
  content: string;
  status: FeedbackStatus;
  author_response: string;
  created_at: string | null;
  responded_at: string | null;
}
