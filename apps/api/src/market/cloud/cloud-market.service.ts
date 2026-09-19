import { Injectable } from '@nestjs/common';
import { ApiException } from '../../contract/errors';
import { nowSql, toIso } from '../../contract/time';
import { SettingsService } from '../../infra/settings.service';
import { PrismaService } from '../../infra/prisma.service';
import type { MarketListing } from '@prisma/client';
import {
  CloudMarketClient,
  CLOUD_ID_PREFIX,
  isCloudListingId,
  toCloudId,
  type CloudListing,
  type CloudConnectedConfig,
} from './cloud.client';
import type {
  MarketCommentDto,
  MarketFeedbackStatus,
  MarketListingDetail,
  MarketListingSummary,
} from '../market.dto';
import type { SkillContent, SkillMcpDependency } from '../../skills/skills.dto';
import { slugify } from '../market.service';

const EMPTY_CONTENT: SkillContent = { blocks: [], entryBlockId: null };

function parseJson<T>(raw: unknown, fallback: T): T {
  if (typeof raw !== 'string') {
    // 服务端直接返回结构化 JSON 时（无 TEXT 包装）原样收下
    return (raw ?? fallback) as T;
  }
  try {
    return (JSON.parse(raw) ?? fallback) as T;
  } catch {
    return fallback;
  }
}

/**
 * 0919 服务端市场对接层：连接管理（设置 kv）、服务端↔本地 DTO 映射、影子 listing 维护。
 * 「本地优先」的聚合/回落决策在 MarketService；本服务只提供服务端侧原语。
 */
@Injectable()
export class CloudMarketService {
  constructor(
    private readonly settings: SettingsService,
    private readonly client: CloudMarketClient,
    private readonly prisma: PrismaService,
  ) {}

  // ---------------------------------------------------------------- 连接管理

  /** connect：先向服务端 login 校验，成功才落设置（url/username/token + enabled）。 */
  async connect(input: { url: string; username: string; password: string }): Promise<{
    connected: boolean;
    url: string;
    username: string;
  }> {
    const base = input.url.replace(/\/+$/, '');
    const login = await this.client.login(base, input.username, input.password);
    await this.settings.patch({
      cloud_url: base,
      cloud_username: login.username || input.username,
      cloud_token: login.token,
      cloud_enabled: true,
    });
    return this.status();
  }

  /** disconnect：关开关并清 token（url/username 留着，方便下次重连回显）。 */
  async disconnect(): Promise<{ connected: boolean; url: string; username: string }> {
    await this.settings.patch({ cloud_enabled: false, cloud_token: '' });
    return this.status();
  }

  async status(): Promise<{ connected: boolean; url: string; username: string }> {
    const cfg = await this.client.config();
    const s = await this.settings.all();
    return { connected: cfg !== null, url: s.cloud_url, username: s.cloud_username };
  }

  // ---------------------------------------------------------------- 服务端读原语（供 MarketService 聚合）

  /** 未连接返回 null（聚合层跳过服务端源）；服务端失败抛 CLOUD_ERROR 由调用方决定回落。 */
  async fetchListings(
    query: Record<string, string | undefined>,
  ): Promise<{ items: MarketListingSummary[]; connected: boolean } | null> {
    const cfg = await this.client.config();
    if (!cfg) return null;
    const items = await this.client.list(cfg, query);
    return { items: items.map((item) => this.toSummary(item, cfg)), connected: true };
  }

  /** 服务端详情 → 本地 detail DTO（comments/rating 取服务端，my.* 查本地影子订阅）。 */
  async fetchDetail(localId: string, accountId: string): Promise<MarketListingDetail> {
    const cfg = await this.requireConfig();
    const cloudId = toCloudId(localId);
    const item = await this.client.detail(cfg, cloudId);
    const summary = this.toSummary(item, cfg);
    const content = parseJson<SkillContent>(item.content, EMPTY_CONTENT);
    const comments = this.cloudComments(item);
    const [subscription] = await Promise.all([
      this.prisma.marketSubscription.findUnique({
        where: { accountId_listingId: { accountId, listingId: localId } },
      }),
    ]);
    return {
      ...summary,
      content,
      mcp_dependencies: parseJson<SkillMcpDependency[]>(item.mcp_dependencies, []),
      comments,
      rating: item.rating ?? { avg: summary.rating_avg, count: summary.rating_count },
      my: {
        subscribed: Boolean(subscription),
        favorited: false,
        rating: null,
      },
    };
  }

  /** 「检查更新」：调服务端 versions 对比；返回服务端最新版本号（无 versions 数据时退回 current_version）。 */
  async fetchLatestVersion(cloudId: string): Promise<string> {
    const cfg = await this.requireConfig();
    const items = await this.client.versions(cfg, cloudId);
    if (items.length > 0) return items[0]!.version;
    const detail = await this.client.detail(cfg, cloudId);
    return detail.current_version ?? '';
  }

  /** 服务端 content 快照（订阅落地用），顺带把影子 listing 拉齐到服务端最新。 */
  async fetchSnapshot(localId: string): Promise<{ row: MarketListing; content: string; mcpDependencies: string; version: string }> {
    const cfg = await this.requireConfig();
    const cloudId = toCloudId(localId);
    const [snap, detail] = await Promise.all([
      this.client.subscribeSnapshot(cfg, cloudId),
      this.client.detail(cfg, cloudId),
    ]);
    const content = JSON.stringify(snap.content ?? detail.content ?? EMPTY_CONTENT);
    const mcpDependencies = JSON.stringify(snap.mcp_dependencies ?? detail.mcp_dependencies ?? []);
    const version = snap.current_version ?? detail.current_version ?? '';
    const row = await this.ensureShadowListing(detail, cfg);
    // 影子 listing 同步到服务端最新，后续 syncSnapshot/订阅复用本地行
    const updated = await this.prisma.marketListing.update({
      where: { id: row.id },
      data: { content, mcpDependencies, currentVersion: version, updatedAt: nowSql() },
    });
    return { row: updated, content, mcpDependencies, version };
  }

  // ---------------------------------------------------------------- 服务端写代理（本地不落库）

  async rate(localId: string, score: number): Promise<{ avg: number; count: number }> {
    const cfg = await this.requireConfig();
    return this.client.rate(cfg, toCloudId(localId), score);
  }

  async comment(localId: string, content: string, accountId: string): Promise<MarketCommentDto> {
    const cfg = await this.requireConfig();
    const created = await this.client.comment(cfg, toCloudId(localId), content);
    return {
      id: created.id,
      account_id: accountId,
      author_name: cfg.username,
      content,
      created_at: toIso(new Date().toISOString()),
    };
  }

  async feedback(localId: string, body: { title: string; content: string }, accountId: string): Promise<{
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
  }> {
    const cfg = await this.requireConfig();
    const created = await this.client.feedback(cfg, toCloudId(localId), body);
    const detail = await this.client.detail(cfg, toCloudId(localId));
    return {
      id: created.id,
      listing_id: localId,
      listing_name: detail.name ?? localId,
      account_id: accountId,
      title: body.title,
      content: body.content,
      status: (created.status ?? 'PENDING') as MarketFeedbackStatus,
      author_response: '',
      created_at: toIso(new Date().toISOString()),
      responded_at: null,
    };
  }

  async report(localId: string, reason: string): Promise<{ ok: true }> {
    const cfg = await this.requireConfig();
    return this.client.report(cfg, toCloudId(localId), reason);
  }

  async toggleFavorite(localId: string): Promise<{ favorited: boolean }> {
    const cfg = await this.requireConfig();
    return this.client.toggleFavorite(cfg, toCloudId(localId));
  }

  // ---------------------------------------------------------------- 发布同步到服务端

  /**
   * 把本地技能当前版本上传服务端。成功后在本地记一条 listing（cloud_listing_id 指向服务端，
   * 状态 PUBLISHED——服务端直发无审核流）。服务端失败时抛 CLOUD_ERROR 且 message 为服务端原文。
   */
  async publishSkill(
    skill: {
      id: string;
      name: string;
      description: string | null;
      tags: string;
      type: string;
      content: string;
      mcpDependencies: string;
      currentVersion: string;
    },
    input: { category: string; license: string; compatible_clients: string[]; visibility: 'public' | 'private' },
    accountId: string,
  ): Promise<MarketListing> {
    const cfg = await this.requireConfig();
    const created = await this.client.publish(cfg, {
      skill_id: skill.id,
      slug: slugify(skill.name),
      name: skill.name,
      description: skill.description ?? '',
      category: input.category,
      tags: parseJson<string[]>(skill.tags, []),
      type: skill.type,
      license: input.license,
      compatible_clients: input.compatible_clients,
      visibility: input.visibility,
      version: skill.currentVersion,
      content: parseJson(skill.content, EMPTY_CONTENT),
      mcp_dependencies: parseJson(skill.mcpDependencies, []),
    });
    if (!created?.id) {
      throw new ApiException('CLOUD_ERROR', '服务端市场发布响应缺少 listing id', undefined, {});
    }
    // 已上过服务端的技能：更新指向；否则新建本地记录
    const existing = await this.prisma.marketListing.findFirst({
      where: { cloudListingId: created.id },
    });
    if (existing) {
      return this.prisma.marketListing.update({
        where: { id: existing.id },
        data: {
          content: skill.content,
          mcpDependencies: skill.mcpDependencies,
          currentVersion: skill.currentVersion,
          status: 'PUBLISHED',
          updatedAt: nowSql(),
        },
      });
    }
    const slug = await this.availableCloudSlug(slugify(skill.name));
    return this.prisma.marketListing.create({
      data: {
        id: `mkt_${crypto.randomUUID().replace(/-/g, '').slice(0, 20)}`,
        slug,
        name: skill.name,
        description: skill.description ?? '',
        category: input.category,
        tags: skill.tags,
        type: skill.type,
        source: 'published',
        cloudListingId: created.id,
        license: input.license,
        compatibleClients: JSON.stringify(input.compatible_clients),
        content: skill.content,
        mcpDependencies: skill.mcpDependencies,
        currentVersion: skill.currentVersion,
        publisherAccountId: accountId,
        status: 'PUBLISHED',
        publishedAt: nowSql(),
      },
    });
  }

  // ---------------------------------------------------------------- 内部

  async requireConfig(): Promise<CloudConnectedConfig> {
    const cfg = await this.client.config();
    if (!cfg) throw new ApiException('CLOUD_ERROR', '服务端市场未连接', undefined, {});
    return cfg;
  }

  /** 服务端条目 → 本地 summary DTO：source='cloud'，id 加 `cld_` 前缀避免与本地 mkt_ 撞。 */
  private toSummary(item: CloudListing, cfg: CloudConnectedConfig): MarketListingSummary {
    const localId = `${CLOUD_ID_PREFIX}${item.id}`;
    return {
      id: localId,
      slug: item.slug ?? item.id,
      name: item.name ?? item.id,
      description: item.description ?? '',
      category: item.category ?? '',
      tags: item.tags ?? [],
      type: item.type ?? 'workflow',
      source: 'cloud',
      license: item.license ?? '',
      compatible_clients: item.compatible_clients ?? [],
      current_version: item.current_version ?? '',
      publisher_account_id: null,
      publisher_name: item.publisher_name ?? cfg.username,
      status: 'PUBLISHED',
      status_label: '已发布',
      review_note: '',
      rating_avg: item.rating?.avg ?? item.rating_avg ?? 0,
      rating_count: item.rating?.count ?? item.rating_count ?? 0,
      subscriber_count: item.subscriber_count ?? 0,
      view_count: 0,
      published_at: item.published_at ?? null,
      created_at: item.published_at ?? null,
    };
  }

  private cloudComments(item: CloudListing): { items: MarketCommentDto[]; total: number } {
    const raw = item.comments;
    if (!raw || !Array.isArray(raw.items)) return { items: [], total: 0 };
    const items = raw.items
      .filter((row): row is Record<string, unknown> => typeof row === 'object' && row !== null)
      .map((row) => ({
        id: String(row.id ?? ''),
        account_id: String(row.account_id ?? ''),
        author_name: String(row.author_name ?? '服务端用户'),
        content: String(row.content ?? ''),
        created_at: (row.created_at as string | null) ?? null,
      }));
    return { items, total: raw.total ?? items.length };
  }

  /**
   * 影子 listing：服务端 listing 在本地 market_listings 里的一行（source='cloud'），
   * 让订阅/评分关系复用既有表结构（subscription.listing_id 有 FK）。幂等。
   */
  private async ensureShadowListing(item: CloudListing, cfg: CloudConnectedConfig): Promise<MarketListing> {
    const localId = `${CLOUD_ID_PREFIX}${item.id}`;
    const existing = await this.prisma.marketListing.findUnique({ where: { id: localId } });
    if (existing) return existing;
    const content = JSON.stringify(item.content ?? EMPTY_CONTENT);
    const mcpDependencies = JSON.stringify(item.mcp_dependencies ?? []);
    return this.prisma.marketListing.create({
      data: {
        id: localId,
        slug: await this.availableCloudSlug(`cloud-${item.slug ?? item.id}`),
        name: item.name ?? item.id,
        description: item.description ?? '',
        category: item.category ?? '',
        tags: JSON.stringify(item.tags ?? []),
        type: item.type ?? 'workflow',
        source: 'cloud',
        cloudListingId: item.id,
        license: item.license ?? '',
        compatibleClients: JSON.stringify(item.compatible_clients ?? []),
        content,
        mcpDependencies,
        currentVersion: item.current_version ?? '',
        status: 'PUBLISHED',
        publishedAt: nowSql(),
      },
    });
  }

  private async availableCloudSlug(base: string): Promise<string> {
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

export { isCloudListingId, toCloudId, CLOUD_ID_PREFIX };
