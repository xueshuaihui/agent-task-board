/**
 * 市场资源类型（apps/api/src/market/market.dto.ts 的人肉镜像；前端不 import 后端包）。
 * 读取模型字段名一律 snake_case，与 skills/types.ts 同一约定。
 * SkillContent / SkillMcpDependency 复用 features/skills 的定义（content JSON 同构）。
 */

import type { SkillContent, SkillMcpDependency } from '@/features/skills/types';

/** 9.1/12.1 分类词表（与后端 MARKET_CATEGORIES 同步）。 */
export const MARKET_CATEGORIES = ['开发流程', '质量保障', '测试', '文档', '部署', '重构', '效率', '写作', '安全', '数据', '运维'] as const;

/** 兼容客户端词表（1.md 示例 payload 里的取值）。 */
export const COMPATIBLE_CLIENTS = ['qoder', 'claude-code', 'codex'] as const;

export type MarketListingStatus = 'PENDING_REVIEW' | 'PUBLISHED' | 'REJECTED' | 'DELISTED' | 'UNLISTED';

export const MARKET_STATUS_LABEL: Record<MarketListingStatus, string> = {
  PENDING_REVIEW: '审核中',
  PUBLISHED: '已发布',
  REJECTED: '已拒绝',
  DELISTED: '已下线',
  UNLISTED: '未发布',
};

export const MARKET_STATUS_TONE: Record<MarketListingStatus, string> = {
  PENDING_REVIEW: 'bg-status-review-soft text-status-review',
  PUBLISHED: 'bg-status-done-soft text-status-done',
  REJECTED: 'bg-status-failed-soft text-status-failed',
  DELISTED: 'bg-bg-muted text-text-secondary',
  UNLISTED: 'bg-bg-muted text-text-secondary',
};

export type MarketSubscriptionStatus = 'SYNCED' | 'HAS_UPDATE' | 'DELISTED';

export type MarketFeedbackStatus = 'PENDING' | 'FIXED_PENDING_VERIFY' | 'RESOLVED' | 'WONTFIX';

export const MARKET_FEEDBACK_STATUS_LABEL: Record<MarketFeedbackStatus, string> = {
  PENDING: '待响应',
  FIXED_PENDING_VERIFY: '待验证',
  RESOLVED: '已解决',
  WONTFIX: '不修复',
};

export type MarketSource = 'builtin' | 'published' | 'cloud';

export type MarketSort = 'hot' | 'new' | 'rating' | 'downloads';

export interface MarketListQuery {
  keyword?: string;
  category?: string;
  type?: string;
  min_rating?: number;
  sort?: MarketSort;
  compatible_client?: string;
}

export interface MarketListingSummary {
  id: string;
  slug: string;
  name: string;
  description: string;
  category: string;
  tags: string[];
  type: string;
  source: MarketSource;
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
  source: MarketSource;
  status: MarketSubscriptionStatus;
  snapshot_version: string;
  latest_version: string;
  skill_id: string | null;
  created_at: string | null;
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

export type { SkillContent, SkillMcpDependency };

/* ---------------- 服务端市场（0919 对接层） ---------------- */

export interface CloudMarketStatus {
  connected: boolean;
  url: string;
  username: string;
}

export interface CloudPublishInput {
  skill_id: string;
  category: string;
  license?: string;
  compatible_clients?: string[];
  visibility: 'public' | 'private' | 'local';
}

/** 市场列表响应的 warning（服务端不可达回落本地时出现）。 */
export interface MarketListResult {
  items: MarketListingSummary[];
  total: number;
  warning?: string;
}
