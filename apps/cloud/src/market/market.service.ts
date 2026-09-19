import { Injectable } from '@nestjs/common';
import { ApiException } from '../contract/errors';
import { uuidv7 } from '../contract/ids';
import { nowSql, toIso } from '../contract/time';
import { PrismaService } from '../infra/prisma.service';
import type {
  MarketComment,
  MarketFeedback,
  MarketListing,
  MarketSubscription,
} from '../../prisma/generated/client';
import {
  type FeedbackStatus,
  type ListingStatus,
  type MarketCommentDto,
  type MarketFeedbackDto,
  type MarketFeedbackInput,
  type MarketFeedbackRespondInput,
  type MarketFeedbackVerifyInput,
  type MarketListQuery,
  type MarketListingDetail,
  type MarketListingSummary,
  type MarketCommentInput,
  type MarketPublishInput,
  type MarketPublishVersionInput,
  type MarketRatingInput,
  type MarketReportInput,
  type MarketSubscriptionDto,
  type SkillContent,
  type SubscriptionStatus,
} from './market.dto';

const EMPTY_CONTENT: SkillContent = { blocks: [], entryBlockId: null };

function parseJson<T>(raw: string, fallback: T): T {
  try {
    const parsed = JSON.parse(raw);
    return (parsed ?? fallback) as T;
  } catch {
    return fallback;
  }
}

/** 发布 slugify：非 ASCII（中文技能名）整体归一为 'skill'，冲突由 availableSlug 加后缀。 */
export function slugify(name: string): string {
  const slug = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return slug || 'skill';
}

@Injectable()
export class MarketService {
  constructor(private readonly prisma: PrismaService) {}

  // ---------------------------------------------------------------- 浏览/详情

  /** 浏览：只出 PUBLISHED；公开可匿名（个人共享模式，发布即上架，无审核环节）。 */
  async list(query: MarketListQuery): Promise<{ items: MarketListingSummary[]; total: number }> {
    const rows = await this.prisma.marketListing.findMany({ where: { status: 'PUBLISHED' } });
    const keyword = query.keyword?.toLowerCase();
    const items: MarketListingSummary[] = [];
    for (const row of rows) {
      if (query.type && row.type !== query.type) continue;
      if (query.category && row.category !== query.category) continue;
      if (keyword) {
        const tags = parseJson<string[]>(row.tags, []);
        const hit =
          row.name.toLowerCase().includes(keyword) ||
          row.description.toLowerCase().includes(keyword) ||
          tags.some((tag) => tag.toLowerCase().includes(keyword));
        if (!hit) continue;
      }
      items.push(await this.toSummary(row));
    }
    const sorted = [...items];
    switch (query.sort) {
      case 'hot':
        sorted.sort((a, b) => b.subscriber_count - a.subscriber_count);
        break;
      case 'new':
        sorted.sort((a, b) => (b.published_at ?? '').localeCompare(a.published_at ?? ''));
        break;
      case 'rating':
        sorted.sort((a, b) => b.rating_avg - a.rating_avg || b.rating_count - a.rating_count);
        break;
    }
    return { items: sorted, total: sorted.length };
  }

  /** 详情：DELISTED 对匿名不可见（404），对任何人可见元信息；含评论。 */
  async detail(id: string, accountId?: string): Promise<MarketListingDetail> {
    const row = await this.requireListing(id);
    if (row.status === 'DELISTED' && !accountId) {
      throw new ApiException('NOT_FOUND', '市场技能不存在');
    }
    await this.prisma.marketListing.update({
      where: { id },
      data: { viewCount: { increment: 1 } },
    });
    return this.buildDetail(row);
  }

  private async buildDetail(row: MarketListing): Promise<MarketListingDetail> {
    return {
      ...(await this.toSummary(row)),
      content: parseJson<SkillContent>(row.content, EMPTY_CONTENT),
      comments: await this.listComments(row.id),
      rating: { avg: row.ratingAvg, count: row.ratingCount },
    };
  }

  // ---------------------------------------------------------------- 发布/版本/下线（个人共享：发布即 PUBLISHED）

  async publish(input: MarketPublishInput, accountId: string): Promise<MarketListingDetail> {
    const slug = await this.availableSlug(input.slug ?? slugify(input.name));
    const row = await this.prisma.marketListing.create({
      data: {
        id: `mkt_${uuidv7()}`,
        slug,
        name: input.name,
        description: input.description,
        category: input.category,
        tags: JSON.stringify(input.tags),
        type: input.type,
        license: input.license,
        compatibleClients: JSON.stringify(input.compatible_clients),
        content: JSON.stringify(input.content),
        mcpDependencies: JSON.stringify(input.mcp_dependencies),
        currentVersion: input.version,
        publisherAccountId: accountId,
        status: 'PUBLISHED',
        publishedAt: nowSql(),
      },
    });
    await this.prisma.marketListingVersion.create({
      data: {
        id: `mkv_${uuidv7()}`,
        listingId: row.id,
        version: input.version,
        content: JSON.stringify(input.content),
        changelog: '首次发布',
      },
    });
    return this.buildDetail(row);
  }

  /** 发新版本：listing 快照跟进；全部 SYNCED 订阅行置 HAS_UPDATE（订阅者视为有更新）。 */
  async publishVersion(
    id: string,
    input: MarketPublishVersionInput,
    accountId: string,
  ): Promise<MarketListingDetail> {
    const row = await this.requireListing(id);
    if (row.publisherAccountId !== accountId) {
      throw new ApiException('FORBIDDEN', '仅发布者本人可以发布新版本');
    }
    const updated = await this.prisma.$transaction([
      this.prisma.marketListing.update({
        where: { id },
        data: { content: JSON.stringify(input.content), currentVersion: input.version, updatedAt: nowSql() },
      }),
      this.prisma.marketListingVersion.create({
        data: {
          id: `mkv_${uuidv7()}`,
          listingId: id,
          version: input.version,
          content: JSON.stringify(input.content),
          changelog: input.changelog,
        },
      }),
      this.prisma.marketSubscription.updateMany({
        where: { listingId: id, status: 'SYNCED' },
        data: { status: 'HAS_UPDATE' },
      }),
    ]);
    return this.buildDetail(updated[0]);
  }

  /** 下线：仅发布者本人（个人共享无管理员介入）；下架 + 全部订阅行置 DELISTED（快照保留）。 */
  async delist(id: string, accountId: string): Promise<MarketListingDetail> {
    const row = await this.requireListing(id);
    if (row.publisherAccountId !== accountId) {
      throw new ApiException('FORBIDDEN', '仅发布者本人可以下线');
    }
    if (row.status === 'DELISTED') {
      throw new ApiException('ILLEGAL_TRANSITION', '该技能已下线', undefined, { status: row.status });
    }
    const [updated] = await this.prisma.$transaction([
      this.prisma.marketListing.update({
        where: { id },
        data: { status: 'DELISTED', updatedAt: nowSql() },
      }),
      this.prisma.marketSubscription.updateMany({
        where: { listingId: id, status: { not: 'DELISTED' } },
        data: { status: 'DELISTED' },
      }),
    ]);
    return this.buildDetail(updated);
  }

  // ---------------------------------------------------------------- 订阅/拉新/取消

  /** 订阅：返回当前快照（content + version）。重复订阅 = 拉齐到最新快照。 */
  async subscribe(
    id: string,
    accountId: string,
  ): Promise<MarketSubscriptionDto & { content: SkillContent }> {
    const row = await this.requireListing(id);
    if (row.status !== 'PUBLISHED') {
      throw new ApiException('ILLEGAL_TRANSITION', '已下线的技能不可订阅', undefined, { status: row.status });
    }
    const existing = await this.prisma.marketSubscription.findUnique({
      where: { accountId_listingId: { accountId, listingId: id } },
    });
    if (existing) {
      await this.syncSnapshot(row, existing);
    } else {
      await this.prisma.$transaction([
        this.prisma.marketSubscription.create({
          data: {
            accountId,
            listingId: id,
            snapshotContent: row.content,
            snapshotVersion: row.currentVersion,
            status: 'SYNCED',
          },
        }),
        this.prisma.marketListing.update({
          where: { id },
          data: { subscriberCount: { increment: 1 } },
        }),
      ]);
    }
    const fresh = (await this.prisma.marketSubscription.findUnique({
      where: { accountId_listingId: { accountId, listingId: id } },
    }))!;
    return {
      ...this.subscriptionDto(fresh, row),
      content: parseJson<SkillContent>(fresh.snapshotContent, EMPTY_CONTENT),
    };
  }

  /** 拉新：把快照升级到 listing 最新版本，status→SYNCED。 */
  async pullUpdate(
    id: string,
    accountId: string,
  ): Promise<MarketSubscriptionDto & { content: SkillContent }> {
    const row = await this.requireListing(id);
    const subscription = await this.prisma.marketSubscription.findUnique({
      where: { accountId_listingId: { accountId, listingId: id } },
    });
    if (!subscription) throw new ApiException('NOT_FOUND', '尚未订阅该技能');
    await this.syncSnapshot(row, subscription);
    const fresh = (await this.prisma.marketSubscription.findUnique({
      where: { accountId_listingId: { accountId, listingId: id } },
    }))!;
    return {
      ...this.subscriptionDto(fresh, row),
      content: parseJson<SkillContent>(fresh.snapshotContent, EMPTY_CONTENT),
    };
  }

  /** 快照对齐：版本不同或已 DELISTED 都落库。 */
  private async syncSnapshot(row: MarketListing, subscription: MarketSubscription): Promise<void> {
    const status: SubscriptionStatus = row.status === 'PUBLISHED' ? 'SYNCED' : 'DELISTED';
    await this.prisma.marketSubscription.update({
      where: { accountId_listingId: { accountId: subscription.accountId, listingId: subscription.listingId } },
      data: {
        snapshotContent: row.content,
        snapshotVersion: row.currentVersion,
        status,
        updatedAt: nowSql(),
      },
    });
  }

  /** 取消订阅：删除订阅行，快照随行丢弃。 */
  async unsubscribe(id: string, accountId: string): Promise<{ ok: true }> {
    const subscription = await this.prisma.marketSubscription.findUnique({
      where: { accountId_listingId: { accountId, listingId: id } },
    });
    if (!subscription) throw new ApiException('NOT_FOUND', '尚未订阅该技能');
    await this.prisma.$transaction([
      this.prisma.marketSubscription.delete({
        where: { accountId_listingId: { accountId, listingId: id } },
      }),
      this.prisma.marketListing.update({
        where: { id },
        data: { subscriberCount: { decrement: 1 } },
      }),
    ]);
    return { ok: true };
  }

  async subscriptions(accountId: string): Promise<{ items: MarketSubscriptionDto[]; total: number }> {
    const rows = await this.prisma.marketSubscription.findMany({
      where: { accountId },
      orderBy: { createdAt: 'desc' },
    });
    const items: MarketSubscriptionDto[] = [];
    for (const row of rows) {
      const listing = await this.prisma.marketListing.findUnique({ where: { id: row.listingId } });
      if (listing) items.push(this.subscriptionDto(row, listing));
    }
    return { items, total: items.length };
  }

  private subscriptionDto(row: MarketSubscription, listing: MarketListing): MarketSubscriptionDto {
    return {
      listing_id: listing.id,
      listing_name: listing.name,
      listing_slug: listing.slug,
      listing_status: listing.status as ListingStatus,
      status: row.status as SubscriptionStatus,
      snapshot_version: row.snapshotVersion,
      latest_version: listing.currentVersion,
      created_at: toIso(row.createdAt),
    };
  }

  // ---------------------------------------------------------------- 评分/评论/收藏/举报

  async rate(id: string, input: MarketRatingInput, accountId: string): Promise<{ avg: number; count: number }> {
    await this.requireListing(id);
    const existing = await this.prisma.marketRating.findUnique({
      where: { accountId_listingId: { accountId, listingId: id } },
    });
    if (existing) {
      await this.prisma.marketRating.update({
        where: { accountId_listingId: { accountId, listingId: id } },
        data: { score: input.score, updatedAt: nowSql() },
      });
    } else {
      await this.prisma.marketRating.create({
        data: { accountId, listingId: id, score: input.score },
      });
    }
    return this.refreshRating(id);
  }

  private async refreshRating(listingId: string): Promise<{ avg: number; count: number }> {
    const agg = await this.prisma.marketRating.aggregate({
      where: { listingId },
      _avg: { score: true },
      _count: { score: true },
    });
    const count = agg._count.score;
    const avg = count > 0 ? Math.round((agg._avg.score ?? 0) * 100) / 100 : 0;
    await this.prisma.marketListing.update({
      where: { id: listingId },
      data: { ratingAvg: avg, ratingCount: count },
    });
    return { avg, count };
  }

  async comment(id: string, input: MarketCommentInput, accountId: string): Promise<MarketCommentDto> {
    await this.requireListing(id);
    const row = await this.prisma.marketComment.create({
      data: { id: `mkc_${uuidv7()}`, accountId, listingId: id, content: input.content },
    });
    return this.commentDto(row, await this.requireAccount(accountId));
  }

  async listComments(listingId: string): Promise<{ items: MarketCommentDto[]; total: number }> {
    const [rows, accounts] = await Promise.all([
      this.prisma.marketComment.findMany({
        where: { listingId },
        orderBy: { createdAt: 'desc' },
      }),
      this.prisma.cloudAccount.findMany({ select: { id: true, username: true, displayName: true } }),
    ]);
    const byId = new Map(accounts.map((row) => [row.id, row]));
    const items = rows.map((row) => this.commentDto(row, byId.get(row.accountId)));
    return { items, total: items.length };
  }

  private commentDto(row: MarketComment, account?: { username: string; displayName: string | null }): MarketCommentDto {
    return {
      id: row.id,
      account_id: row.accountId,
      author_name: account ? account.displayName || account.username : '未知用户',
      content: row.content,
      created_at: toIso(row.createdAt),
    };
  }

  /** 评论删除：仅评论作者本人或 ADMIN。 */
  async deleteComment(commentId: string, accountId: string, role: 'MEMBER' | 'ADMIN'): Promise<{ ok: true }> {
    const row = await this.prisma.marketComment.findUnique({ where: { id: commentId } });
    if (!row) throw new ApiException('NOT_FOUND', '评论不存在');
    if (row.accountId !== accountId && role !== 'ADMIN') {
      throw new ApiException('FORBIDDEN', '仅评论作者或管理员可以删除评论');
    }
    await this.prisma.marketComment.delete({ where: { id: commentId } });
    return { ok: true };
  }

  async toggleFavorite(id: string, accountId: string): Promise<{ favorited: boolean }> {
    await this.requireListing(id);
    const existing = await this.prisma.marketFavorite.findUnique({
      where: { accountId_listingId: { accountId, listingId: id } },
    });
    if (existing) {
      await this.prisma.marketFavorite.delete({
        where: { accountId_listingId: { accountId, listingId: id } },
      });
      return { favorited: false };
    }
    await this.prisma.marketFavorite.create({ data: { accountId, listingId: id } });
    return { favorited: true };
  }

  async report(id: string, input: MarketReportInput, accountId: string): Promise<{ ok: true }> {
    await this.requireListing(id);
    await this.prisma.marketReport.create({
      data: { id: `mkr_${uuidv7()}`, accountId, listingId: id, reason: input.reason },
    });
    return { ok: true };
  }

  // ---------------------------------------------------------------- 反馈闭环：提交 → 作者响应 → 提交者验证

  async createFeedback(id: string, input: MarketFeedbackInput, accountId: string): Promise<MarketFeedbackDto> {
    const listing = await this.requireListing(id);
    const row = await this.prisma.marketFeedback.create({
      data: {
        id: `mkf_${uuidv7()}`,
        accountId,
        listingId: id,
        title: input.title,
        content: input.content,
      },
    });
    return this.feedbackDto(row, listing);
  }

  /** 作者响应：仅 publisher 本人；fixed→FIXED_PENDING_VERIFY，wontfix→WONTFIX（闭环）。 */
  async respondFeedback(
    feedbackId: string,
    input: MarketFeedbackRespondInput,
    accountId: string,
  ): Promise<MarketFeedbackDto> {
    const row = await this.prisma.marketFeedback.findUnique({ where: { id: feedbackId } });
    if (!row) throw new ApiException('NOT_FOUND', '反馈不存在');
    const listing = await this.requireListing(row.listingId);
    if (listing.publisherAccountId !== accountId) {
      throw new ApiException('FORBIDDEN', '仅技能发布者可以响应反馈');
    }
    if (row.status === 'RESOLVED' || row.status === 'WONTFIX') {
      throw new ApiException('ILLEGAL_TRANSITION', '该反馈已闭环', undefined, { status: row.status });
    }
    const updated = await this.prisma.marketFeedback.update({
      where: { id: feedbackId },
      data: {
        status: input.resolution === 'fixed' ? 'FIXED_PENDING_VERIFY' : 'WONTFIX',
        authorResponse: input.response,
        respondedAt: nowSql(),
      },
    });
    return this.feedbackDto(updated, listing);
  }

  /** 提交者验证：confirmed→RESOLVED，否则回到 PENDING（继续等作者响应）。 */
  async verifyFeedback(
    feedbackId: string,
    input: MarketFeedbackVerifyInput,
    accountId: string,
  ): Promise<MarketFeedbackDto> {
    const row = await this.prisma.marketFeedback.findUnique({ where: { id: feedbackId } });
    if (!row) throw new ApiException('NOT_FOUND', '反馈不存在');
    if (row.accountId !== accountId) {
      throw new ApiException('FORBIDDEN', '仅反馈提交者可以验证修复');
    }
    if (row.status !== 'FIXED_PENDING_VERIFY') {
      throw new ApiException('ILLEGAL_TRANSITION', '当前状态无可验证的修复', undefined, { status: row.status });
    }
    const listing = await this.requireListing(row.listingId);
    const updated = await this.prisma.marketFeedback.update({
      where: { id: feedbackId },
      data: { status: input.confirmed ? 'RESOLVED' : 'PENDING' },
    });
    return this.feedbackDto(updated, listing);
  }

  // ---------------------------------------------------------------- 我的（发布/收藏/反馈）

  async myPublishes(accountId: string): Promise<{ items: MarketListingSummary[]; total: number }> {
    const rows = await this.prisma.marketListing.findMany({
      where: { publisherAccountId: accountId },
      orderBy: { createdAt: 'desc' },
    });
    const items = await Promise.all(rows.map((row) => this.toSummary(row)));
    return { items, total: items.length };
  }

  async myFavorites(accountId: string): Promise<{ items: MarketListingSummary[]; total: number }> {
    const rows = await this.prisma.marketFavorite.findMany({
      where: { accountId },
      orderBy: { createdAt: 'desc' },
    });
    const items: MarketListingSummary[] = [];
    for (const row of rows) {
      const listing = await this.prisma.marketListing.findUnique({ where: { id: row.listingId } });
      if (listing) items.push(await this.toSummary(listing));
    }
    return { items, total: items.length };
  }

  async myFeedbacks(accountId: string): Promise<{ items: MarketFeedbackDto[]; total: number }> {
    const rows = await this.prisma.marketFeedback.findMany({
      where: { accountId },
      orderBy: { createdAt: 'desc' },
    });
    const items: MarketFeedbackDto[] = [];
    for (const row of rows) {
      const listing = await this.prisma.marketListing.findUnique({ where: { id: row.listingId } });
      items.push(await this.feedbackDto(row, listing ?? undefined));
    }
    return { items, total: items.length };
  }

  // ---------------------------------------------------------------- 内部

  private async requireListing(id: string): Promise<MarketListing> {
    const row = await this.prisma.marketListing.findUnique({ where: { id } });
    if (!row) throw new ApiException('NOT_FOUND', '市场技能不存在');
    return row;
  }

  private async requireAccount(id: string): Promise<{ id: string; username: string; displayName: string | null }> {
    const row = await this.prisma.cloudAccount.findUnique({
      where: { id },
      select: { id: true, username: true, displayName: true },
    });
    if (!row) throw new ApiException('UNAUTHORIZED', '账号不存在或已禁用');
    return row;
  }

  private async toSummary(row: MarketListing): Promise<MarketListingSummary> {
    const account = row.publisherAccountId ? await this.requireAccount(row.publisherAccountId) : null;
    return {
      id: row.id,
      slug: row.slug,
      name: row.name,
      description: row.description,
      category: row.category,
      tags: parseJson<string[]>(row.tags, []),
      type: row.type,
      license: row.license,
      compatible_clients: parseJson<string[]>(row.compatibleClients, []),
      mcp_dependencies: parseJson(row.mcpDependencies, []),
      current_version: row.currentVersion,
      publisher_account_id: row.publisherAccountId,
      publisher_name: account ? account.displayName || account.username : '未知用户',
      status: row.status as ListingStatus,
      rating_avg: row.ratingAvg,
      rating_count: row.ratingCount,
      subscriber_count: row.subscriberCount,
      view_count: row.viewCount,
      published_at: toIso(row.publishedAt),
      created_at: toIso(row.createdAt),
    };
  }

  private async feedbackDto(row: MarketFeedback, listing?: MarketListing): Promise<MarketFeedbackDto> {
    return {
      id: row.id,
      listing_id: row.listingId,
      listing_name: listing?.name ?? row.listingId,
      account_id: row.accountId,
      title: row.title,
      content: row.content,
      status: row.status as FeedbackStatus,
      author_response: row.authorResponse,
      created_at: toIso(row.createdAt),
      responded_at: toIso(row.respondedAt),
    };
  }

  /** 重名 slug 加数字后缀：code-review → code-review-2 → code-review-3 … */
  private async availableSlug(base: string): Promise<string> {
    const existing = await this.prisma.marketListing.findMany({
      where: { slug: { startsWith: base } },
      select: { slug: true },
    });
    const taken = new Set(existing.map((row) => row.slug));
    if (!taken.has(base)) return base;
    for (let i = 2; ; i += 1) {
      const candidate = `${base}-${i}`;
      if (!taken.has(candidate)) return candidate;
    }
  }
}
