import { Injectable, OnModuleInit } from '@nestjs/common';
import { ApiException } from '../contract/errors';
import { uuidv7 } from '../contract/ids';
import { nowSql, toIso } from '../contract/time';
import type { MarketComment, MarketFeedback, MarketListing, MarketSubscription } from '@prisma/client';
import { PrismaService } from '../infra/prisma.service';
import {
  MARKET_STATUS_LABEL,
  type MarketCommentDto,
  type MarketFeedbackDto,
  type MarketFeedbackStatus,
  type MarketFeedbackVerifyInput,
  type MarketListQuery,
  type MarketListingDetail,
  type MarketListingStatus,
  type MarketListingSummary,
  type MarketPublishInput,
  type MarketPublishVersionInput,
  type MarketRatingInput,
  type MarketCommentInput,
  type MarketReportInput,
  type MarketFeedbackInput,
  type MarketFeedbackRespondInput,
  type MarketSubscriptionDto,
  type MarketSubscriptionStatus,
  type MarketReviewInput,
} from './market.dto';
import { BUILTIN_LISTINGS } from './market.seed';
import type { SkillContent, SkillMcpDependency } from '../skills/skills.dto';

const EMPTY_CONTENT: SkillContent = { blocks: [], entryBlockId: null };

function parseJson<T>(raw: string, fallback: T): T {
  try {
    const parsed = JSON.parse(raw);
    return (parsed ?? fallback) as T;
  } catch {
    return fallback;
  }
}

/** 发布 slugify：非 ASCII（中文技能名）整体归一为 'skill'，冲突由调用方加后缀。 */
export function slugify(name: string): string {
  const slug = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return slug || 'skill';
}

interface AccountBrief {
  id: string;
  username: string;
  displayName: string | null;
}

@Injectable()
export class MarketService implements OnModuleInit {
  constructor(private readonly prisma: PrismaService) {}

  /** 8.8 内置技能：启动时按 slug 幂等种子（已存在即跳过）。 */
  async onModuleInit(): Promise<void> {
    await this.seedBuiltins();
  }

  async seedBuiltins(): Promise<number> {
    const existing = await this.prisma.marketListing.findMany({
      where: { slug: { in: BUILTIN_LISTINGS.map((row) => row.slug) } },
      select: { slug: true },
    });
    const have = new Set(existing.map((row) => row.slug));
    let created = 0;
    for (const seed of BUILTIN_LISTINGS) {
      if (have.has(seed.slug)) continue;
      await this.prisma.marketListing.create({
        data: {
          id: `mkt_${uuidv7()}`,
          slug: seed.slug,
          name: seed.name,
          description: seed.description,
          category: seed.category,
          tags: JSON.stringify(seed.tags),
          type: seed.type,
          source: 'builtin',
          license: seed.license,
          compatibleClients: JSON.stringify(seed.compatible_clients),
          content: JSON.stringify(seed.content),
          mcpDependencies: JSON.stringify(seed.mcp_dependencies),
          currentVersion: seed.current_version,
          status: 'PUBLISHED',
          publishedAt: nowSql(),
        },
      });
      created += 1;
    }
    return created;
  }

  // ---------------------------------------------------------------- 浏览/详情（9.1/9.2）

  /** 浏览：只出 PUBLISHED（builtin 种子即 PUBLISHED）；UNLISTED 只在我的发布可见。 */
  async list(
    query: MarketListQuery,
    accountId: string,
  ): Promise<{ items: MarketListingSummary[]; total: number }> {
    const rows = await this.prisma.marketListing.findMany({ where: { status: 'PUBLISHED' } });
    const keyword = query.keyword?.toLowerCase();
    const items: MarketListingSummary[] = [];
    for (const row of rows) {
      if (query.type && row.type !== query.type) continue;
      if (query.category && row.category !== query.category) continue;
      if (query.min_rating !== undefined && row.ratingAvg < query.min_rating) continue;
      if (query.compatible_client) {
        const clients = parseJson<string[]>(row.compatibleClients, []);
        if (!clients.includes(query.compatible_client)) continue;
      }
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
    const sorted = this.sortListings(items, query.sort);
    void accountId;
    return { items: sorted, total: sorted.length };
  }

  private sortListings(items: MarketListingSummary[], sort: MarketListQuery['sort']): MarketListingSummary[] {
    const sorted = [...items];
    switch (sort) {
      case 'hot':
      case 'downloads':
        // hot=subscriber_count desc；「下载量」与订阅同源（9.2 排序词表）
        sorted.sort((a, b) => b.subscriber_count - a.subscriber_count);
        break;
      case 'new':
        sorted.sort((a, b) => (b.published_at ?? '').localeCompare(a.published_at ?? ''));
        break;
      case 'rating':
        sorted.sort((a, b) => b.rating_avg - a.rating_avg || b.rating_count - a.rating_count);
        break;
    }
    return sorted;
  }

  async detail(id: string, accountId: string): Promise<MarketListingDetail> {
    const row = await this.prisma.marketListing.findUnique({ where: { id } });
    if (!row) throw new ApiException('NOT_FOUND', '市场技能不存在');
    // UNLISTED/PENDING/REJECTED/DELISTED 只有发布者本人与 ADMIN 可见（14.2 我的发布口径）
    if (row.status !== 'PUBLISHED') {
      const auth = await this.requireAccount(accountId);
      if (row.publisherAccountId !== auth.id && auth.role !== 'ADMIN') {
        throw new ApiException('NOT_FOUND', '市场技能不存在');
      }
    }
    await this.prisma.marketListing.update({
      where: { id },
      data: { viewCount: { increment: 1 } },
    });
    const [comments, subscription, favorite, rating, publisher] = await Promise.all([
      this.listComments(id),
      this.prisma.marketSubscription.findUnique({
        where: { accountId_listingId: { accountId, listingId: id } },
      }),
      this.prisma.marketFavorite.findUnique({
        where: { accountId_listingId: { accountId, listingId: id } },
      }),
      this.prisma.marketRating.findUnique({
        where: { accountId_listingId: { accountId, listingId: id } },
      }),
      row.publisherAccountId ? this.requireAccount(row.publisherAccountId) : null,
    ]);
    return {
      ...(await this.toSummary(row, publisher)),
      content: parseJson<SkillContent>(row.content, EMPTY_CONTENT),
      mcp_dependencies: parseJson<SkillMcpDependency[]>(row.mcpDependencies, []),
      comments,
      rating: { avg: row.ratingAvg, count: row.ratingCount },
      my: {
        subscribed: Boolean(subscription),
        favorited: Boolean(favorite),
        rating: rating?.score ?? null,
      },
    };
  }

  // ---------------------------------------------------------------- 发布/审核/下线（9.3/9.4）

  /** 发布：从技能当前版本拍快照建 listing；private→UNLISTED（未发布），public→PENDING_REVIEW（审核中）。 */
  async publish(input: MarketPublishInput, accountId: string): Promise<MarketListingDetail> {
    const skill = await this.prisma.skill.findFirst({ where: { id: input.skill_id, accountId } });
    if (!skill) throw new ApiException('NOT_FOUND', '技能不存在');
    // 9.3：发布的是「可用技能」，草稿/归档先去发布技能本身
    if (skill.status !== 'PUBLISHED') {
      throw new ApiException('ILLEGAL_TRANSITION', '技能需先发布（PUBLISHED）才能上架市场', undefined, {
        skill_status: skill.status,
      });
    }
    const content = parseJson<SkillContent>(skill.content, EMPTY_CONTENT);
    const slug = await this.availableSlug(slugify(skill.name));
    const row = await this.prisma.marketListing.create({
      data: {
        id: `mkt_${uuidv7()}`,
        slug,
        name: skill.name,
        description: skill.description,
        category: input.category,
        tags: skill.tags,
        type: skill.type,
        source: 'published',
        license: input.license,
        compatibleClients: JSON.stringify(input.compatible_clients),
        content: skill.content,
        mcpDependencies: skill.mcpDependencies,
        currentVersion: skill.currentVersion,
        publisherAccountId: accountId,
        status: input.visibility === 'private' ? 'UNLISTED' : 'PENDING_REVIEW',
      },
    });
    return this.detail(row.id, accountId);
  }

  /** 审核：仅 ADMIN；approve→PUBLISHED（记 published_at），reject→REJECTED。 */
  async review(id: string, input: MarketReviewInput, accountId: string): Promise<MarketListingDetail> {
    const auth = await this.requireAccount(accountId);
    if (auth.role !== 'ADMIN') throw new ApiException('FORBIDDEN', '仅管理员可以审核市场技能');
    const row = await this.requireListing(id);
    if (row.status !== 'PENDING_REVIEW') {
      throw new ApiException('ILLEGAL_TRANSITION', `当前状态 ${MARKET_STATUS_LABEL[row.status as MarketListingStatus]} 不可审核`, undefined, {
        status: row.status,
      });
    }
    await this.prisma.marketListing.update({
      where: { id },
      data: {
        status: input.action === 'approve' ? 'PUBLISHED' : 'REJECTED',
        reviewNote: input.reason,
        publishedAt: input.action === 'approve' ? nowSql() : null,
        updatedAt: nowSql(),
      },
    });
    return this.detail(id, accountId);
  }

  /** 下线（9.4）：publisher 或 ADMIN；云端下架 + 全部订阅行置 DELISTED（快照保留）。 */
  async delist(id: string, accountId: string): Promise<MarketListingDetail> {
    const auth = await this.requireAccount(accountId);
    const row = await this.requireListing(id);
    if (row.publisherAccountId !== auth.id && auth.role !== 'ADMIN') {
      throw new ApiException('FORBIDDEN', '仅发布者本人或管理员可以下线');
    }
    if (row.status === 'DELISTED') {
      throw new ApiException('ILLEGAL_TRANSITION', '该技能已下线', undefined, { status: row.status });
    }
    await this.prisma.$transaction([
      this.prisma.marketListing.update({
        where: { id },
        data: { status: 'DELISTED', updatedAt: nowSql() },
      }),
      this.prisma.marketSubscription.updateMany({
        where: { listingId: id },
        data: { status: 'DELISTED' },
      }),
    ]);
    return this.detail(id, accountId);
  }

  /** 发布者发新版本：listing 快照跟进技能新版本，全部 SYNCED 订阅行置 HAS_UPDATE。 */
  async publishVersion(
    id: string,
    input: MarketPublishVersionInput,
    accountId: string,
  ): Promise<MarketListingDetail> {
    const row = await this.requireListing(id);
    if (row.publisherAccountId !== accountId) {
      throw new ApiException('FORBIDDEN', '仅发布者本人可以发布新版本');
    }
    const skill = await this.prisma.skill.findFirst({ where: { id: input.skill_id, accountId } });
    if (!skill) throw new ApiException('NOT_FOUND', '技能不存在');
    await this.prisma.$transaction([
      this.prisma.marketListing.update({
        where: { id },
        data: {
          name: skill.name,
          description: skill.description,
          tags: skill.tags,
          content: skill.content,
          mcpDependencies: skill.mcpDependencies,
          currentVersion: skill.currentVersion,
          updatedAt: nowSql(),
        },
      }),
      this.prisma.marketSubscription.updateMany({
        where: { listingId: id, status: 'SYNCED' },
        data: { status: 'HAS_UPDATE' },
      }),
    ]);
    return this.detail(id, accountId);
  }

  // ---------------------------------------------------------------- 订阅（9.4/14.1）

  /** 订阅：拍当前快照，并在本账号 skills 落地/更新一个市场技能（source='market'），重名加后缀。 */
  async subscribe(
    id: string,
    accountId: string,
  ): Promise<MarketSubscriptionDto & { content: SkillContent }> {
    const row = await this.requireListing(id);
    if (row.status !== 'PUBLISHED') {
      throw new ApiException('ILLEGAL_TRANSITION', `当前状态「${MARKET_STATUS_LABEL[row.status as MarketListingStatus]}」不可订阅`, undefined, {
        status: row.status,
      });
    }
    const content = parseJson<SkillContent>(row.content, EMPTY_CONTENT);
    const deps = parseJson<SkillMcpDependency[]>(row.mcpDependencies, []);
    const existing = await this.prisma.marketSubscription.findUnique({
      where: { accountId_listingId: { accountId, listingId: id } },
    });
    if (existing) {
      // 重复订阅 = 拉齐到最新快照
      await this.syncSnapshot(row, existing);
      return this.subscriptionDto(
        (await this.prisma.marketSubscription.findUnique({
          where: { accountId_listingId: { accountId, listingId: id } },
        }))!,
        row,
      );
    }
    const name = await this.availableSkillName(row.name, accountId);
    const skillId = `skl_${uuidv7()}`;
    await this.prisma.$transaction([
      this.prisma.skill.create({
        data: {
          id: skillId,
          accountId,
          name,
          type: row.type,
          status: 'PUBLISHED',
          description: row.description,
          tags: row.tags,
          source: 'market',
          currentVersion: row.currentVersion,
          content: row.content,
          mcpDependencies: row.mcpDependencies,
        },
      }),
      this.prisma.skillVersion.create({
        data: {
          id: `slv_${uuidv7()}`,
          skillId,
          version: row.currentVersion,
          content: row.content,
          mcpDependencies: row.mcpDependencies,
          changelog: `市场订阅：${row.name} ${row.currentVersion}`,
        },
      }),
      this.prisma.marketSubscription.create({
        data: {
          accountId,
          listingId: id,
          snapshotContent: row.content,
          snapshotVersion: row.currentVersion,
          status: 'SYNCED',
          skillId,
        },
      }),
      this.prisma.marketListing.update({
        where: { id },
        data: { subscriberCount: { increment: 1 } },
      }),
    ]);
    return this.subscriptionDto(
      (await this.prisma.marketSubscription.findUnique({
        where: { accountId_listingId: { accountId, listingId: id } },
      }))!,
      row,
    );
  }

  /** 拉新：把本地技能升级到 listing 最新快照（走 skill_versions 新版本），status→SYNCED。 */
  async pullUpdate(id: string, accountId: string): Promise<MarketSubscriptionDto & { content: SkillContent }> {
    const row = await this.requireListing(id);
    const subscription = await this.prisma.marketSubscription.findUnique({
      where: { accountId_listingId: { accountId, listingId: id } },
    });
    if (!subscription) throw new ApiException('NOT_FOUND', '尚未订阅该技能');
    await this.syncSnapshot(row, subscription);
    return this.subscriptionDto(
      (await this.prisma.marketSubscription.findUnique({
        where: { accountId_listingId: { accountId, listingId: id } },
      }))!,
      row,
    );
  }

  /** 快照对齐：更新订阅行 + 本地技能（版本不同则新增 skill_version）。 */
  private async syncSnapshot(row: MarketListing, subscription: MarketSubscription): Promise<void> {
    const data: Record<string, unknown> = {
      snapshotContent: row.content,
      snapshotVersion: row.currentVersion,
      status: row.status === 'PUBLISHED' ? 'SYNCED' : 'DELISTED',
    };
    await this.prisma.marketSubscription.update({
      where: { accountId_listingId: { accountId: subscription.accountId, listingId: subscription.listingId } },
      data,
    });
    if (subscription.skillId) {
      const skill = await this.prisma.skill.findFirst({ where: { id: subscription.skillId, accountId: subscription.accountId } });
      if (skill) {
        const versionExists = await this.prisma.skillVersion.findUnique({
          where: { skillId_version: { skillId: skill.id, version: row.currentVersion } },
        });
        await this.prisma.$transaction([
          ...(versionExists
            ? []
            : [
                this.prisma.skillVersion.create({
                  data: {
                    id: `slv_${uuidv7()}`,
                    skillId: skill.id,
                    version: row.currentVersion,
                    content: row.content,
                    mcpDependencies: row.mcpDependencies,
                    changelog: `市场更新：${row.name} ${row.currentVersion}`,
                  },
                }),
              ]),
          this.prisma.skill.update({
            where: { id: skill.id },
            data: {
              currentVersion: row.currentVersion,
              content: row.content,
              mcpDependencies: row.mcpDependencies,
              description: row.description,
              tags: row.tags,
              updatedAt: nowSql(),
            },
          }),
        ]);
      }
    }
  }

  /** 取消订阅：本地技能保留，解除关联（删除订阅行）。 */
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
      if (!listing) continue;
      items.push(await this.subscriptionDto(row, listing));
    }
    return { items, total: items.length };
  }

  private async subscriptionDto(
    row: MarketSubscription,
    listing: MarketListing,
  ): Promise<MarketSubscriptionDto & { content: SkillContent }> {
    return {
      listing_id: listing.id,
      listing_name: listing.name,
      listing_slug: listing.slug,
      listing_status: listing.status as MarketListingStatus,
      source: listing.source as 'builtin' | 'published',
      status: row.status as MarketSubscriptionStatus,
      snapshot_version: row.snapshotVersion,
      latest_version: listing.currentVersion,
      skill_id: row.skillId,
      created_at: toIso(row.createdAt),
      content: parseJson<SkillContent>(row.snapshotContent, EMPTY_CONTENT),
    };
  }

  // ---------------------------------------------------------------- 评分/评论/收藏/举报（9.5）

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
      this.prisma.account.findMany({ select: { id: true, username: true, displayName: true } }),
    ]);
    const byId = new Map(accounts.map((row) => [row.id, row]));
    const items = rows.map((row) => this.commentDto(row, byId.get(row.accountId)));
    return { items, total: items.length };
  }

  private commentDto(row: MarketComment, account?: AccountBrief): MarketCommentDto {
    return {
      id: row.id,
      account_id: row.accountId,
      author_name: account ? (account.displayName || account.username) : '未知用户',
      content: row.content,
      created_at: toIso(row.createdAt),
    };
  }

  async deleteComment(commentId: string, accountId: string): Promise<{ ok: true }> {
    const row = await this.prisma.marketComment.findUnique({ where: { id: commentId } });
    if (!row) throw new ApiException('NOT_FOUND', '评论不存在');
    const auth = await this.requireAccount(accountId);
    if (row.accountId !== auth.id && auth.role !== 'ADMIN') {
      throw new ApiException('FORBIDDEN', '仅评论作者或管理员可以删除评论');
    }
    await this.prisma.marketComment.delete({ where: { id: commentId } });
    return { ok: true };
  }

  /** 收藏 toggle。 */
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

  // ---------------------------------------------------------------- 反馈闭环（9.5/14.3）

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

  /** 作者响应：仅 listing publisher 本人；fixed→FIXED_PENDING_VERIFY，wontfix→WONTFIX。 */
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
  async verifyFeedback(feedbackId: string, input: MarketFeedbackVerifyInput, accountId: string): Promise<MarketFeedbackDto> {
    const row = await this.prisma.marketFeedback.findUnique({ where: { id: feedbackId } });
    if (!row) throw new ApiException('NOT_FOUND', '反馈不存在');
    if (row.accountId !== accountId) {
      throw new ApiException('FORBIDDEN', '仅反馈提交者可以验证修复');
    }
    if (row.status !== 'FIXED_PENDING_VERIFY') {
      throw new ApiException('ILLEGAL_TRANSITION', '当前状态无可验证的修复', undefined, { status: row.status });
    }
    const listing = await this.requireListing(row.listingId);
    const next: MarketFeedbackStatus = input.confirmed ? 'RESOLVED' : 'PENDING';
    const updated = await this.prisma.marketFeedback.update({
      where: { id: feedbackId },
      data: { status: next },
    });
    return this.feedbackDto(updated, listing);
  }

  // ---------------------------------------------------------------- 我的（14 章）

  async myPublishes(accountId: string): Promise<{ items: MarketListingSummary[]; total: number }> {
    const rows = await this.prisma.marketListing.findMany({
      where: { publisherAccountId: accountId },
      orderBy: { createdAt: 'desc' },
    });
    const items = await Promise.all(rows.map((row) => this.toSummary(row)));
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

  // ---------------------------------------------------------------- 内部

  private async requireListing(id: string): Promise<MarketListing> {
    const row = await this.prisma.marketListing.findUnique({ where: { id } });
    if (!row) throw new ApiException('NOT_FOUND', '市场技能不存在');
    return row;
  }

  private async requireAccount(id: string): Promise<AccountBrief & { role: string }> {
    const row = await this.prisma.account.findUnique({
      where: { id },
      select: { id: true, username: true, displayName: true, role: true },
    });
    if (!row) throw new ApiException('UNAUTHORIZED', '账号不存在或已禁用');
    return row;
  }

  /** publisher 显示名；builtin 无 publisher → 「官方」（原型 12.1「📦 内置」）。 */
  private async toSummary(row: MarketListing, publisher?: AccountBrief | null): Promise<MarketListingSummary> {
    const account = publisher ?? (row.publisherAccountId ? await this.requireAccount(row.publisherAccountId) : null);
    return {
      id: row.id,
      slug: row.slug,
      name: row.name,
      description: row.description,
      category: row.category,
      tags: parseJson<string[]>(row.tags, []),
      type: row.type,
      source: row.source as 'builtin' | 'published',
      license: row.license,
      compatible_clients: parseJson<string[]>(row.compatibleClients, []),
      current_version: row.currentVersion,
      publisher_account_id: row.publisherAccountId,
      publisher_name: account ? account.displayName || account.username : '官方',
      status: row.status as MarketListingStatus,
      status_label: MARKET_STATUS_LABEL[row.status as MarketListingStatus] ?? row.status,
      review_note: row.reviewNote,
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
      status: row.status as MarketFeedbackStatus,
      author_response: row.authorResponse,
      created_at: toIso(row.createdAt),
      responded_at: toIso(row.respondedAt),
    };
  }

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

  private async availableSkillName(name: string, accountId: string): Promise<string> {
    const existing = await this.prisma.skill.findMany({
      where: { accountId, name: { startsWith: name } },
      select: { name: true },
    });
    const taken = new Set(existing.map((row) => row.name));
    if (!taken.has(name)) return name;
    for (let i = 2; ; i += 1) {
      const candidate = `${name} (${i})`;
      if (!taken.has(candidate)) return candidate;
    }
  }
}
