import { Injectable } from '@nestjs/common';
import { ApiException } from '../../contract/errors';
import { SettingsService } from '../../infra/settings.service';

/**
 * 0919 服务端市场 HTTP 客户端（只管传输，不做映射/落库）。
 *
 * 服务端契约（与 apps/cloud 同一约定，JWT Bearer）：
 * - POST   {base}/cloud/v1/accounts/login            {username, password} → {token, username}
 * - GET    {base}/cloud/v1/market/listings           ?keyword&category&type&sort → {items: CloudListing[]}
 * - GET    {base}/cloud/v1/market/listings/:id       → CloudListingDetail（含 content/comments/rating）
 * - GET    {base}/cloud/v1/market/listings/:id/versions → {items: [{version, published_at}]}
 * - POST   {base}/cloud/v1/market/publish            发布（技能快照上传）→ {id, slug}
 * - POST   {base}/cloud/v1/market/listings/:id/subscribe → {content, mcp_dependencies, current_version}
 * - POST   {base}/cloud/v1/market/listings/:id/rating    {score} → {avg, count}
 * - POST   {base}/cloud/v1/market/listings/:id/comments  {content} → {id}
 * - POST   {base}/cloud/v1/market/listings/:id/feedback  {title, content} → {id, status}
 * - POST   {base}/cloud/v1/market/listings/:id/favorite  → {favorited}
 * - POST   {base}/cloud/v1/market/listings/:id/report     {reason} → {ok: true}
 *
 * 所有失败（网络/超时/非 2xx）统一抛 CLOUD_ERROR，message 尽量带服务端原文；
 * 「静默回落本地」由调用方（MarketService 聚合读路径）捕获决定，客户端不吞错。
 */

export const CLOUD_ID_PREFIX = 'cld_';

export function isCloudListingId(id: string): boolean {
  return id.startsWith(CLOUD_ID_PREFIX);
}

/** 本地命名空间的 listing id → 服务端原始 id。 */
export function toCloudId(localId: string): string {
  return localId.slice(CLOUD_ID_PREFIX.length);
}

/** 服务端返回的 listing 条目（与本地 summary 字段同名，缺省字段由映射层补）。 */
export interface CloudListing {
  id: string;
  slug: string;
  name: string;
  description?: string;
  category?: string;
  tags?: string[];
  type?: string;
  license?: string;
  compatible_clients?: string[];
  current_version?: string;
  publisher_name?: string;
  rating_avg?: number;
  rating_count?: number;
  subscriber_count?: number;
  published_at?: string | null;
  content?: unknown;
  mcp_dependencies?: unknown[];
  comments?: { items: unknown[]; total: number };
  rating?: { avg: number; count: number };
}

export interface CloudConnectedConfig {
  url: string;
  token: string;
  username: string;
}

const TIMEOUT_MS = 5000;

@Injectable()
export class CloudMarketClient {
  constructor(private readonly settings: SettingsService) {}

  /** connected = 开关打开 + url/token 齐备（token 由 connect 的 login 换取）。 */
  async config(): Promise<CloudConnectedConfig | null> {
    const s = await this.settings.all();
    if (!s.cloud_enabled || !s.cloud_url || !s.cloud_token) return null;
    return { url: s.cloud_url.replace(/\/+$/, ''), token: s.cloud_token, username: s.cloud_username };
  }

  async isConnected(): Promise<boolean> {
    return (await this.config()) !== null;
  }

  /**
   * 登录换取 token（connect 用）。登录失败抛 CLOUD_ERROR 且 message 带服务端原文
   * （如「用户名或密码错误」），设置页直接透出。
   */
  async login(base: string, username: string, password: string): Promise<{ token: string; username: string }> {
    const body = await this.request<{ token: string; username: string }>(
      base,
      'POST',
      '/cloud/v1/accounts/login',
      { body: { username, password } },
    );
    if (!body?.token) {
      throw new ApiException('CLOUD_ERROR', '服务端登录响应缺少 token', undefined, { url: base });
    }
    return body;
  }

  async list(cfg: CloudConnectedConfig, query: Record<string, string | undefined>): Promise<CloudListing[]> {
    const body = await this.request<{ items: CloudListing[] }>(
      cfg.url, 'GET', '/cloud/v1/market/listings', { query, token: cfg.token },
    );
    return Array.isArray(body?.items) ? body.items : [];
  }

  async detail(cfg: CloudConnectedConfig, cloudId: string): Promise<CloudListing> {
    return this.request<CloudListing>(cfg.url, 'GET', `/cloud/v1/market/listings/${encodeURIComponent(cloudId)}`, {
      token: cfg.token,
    });
  }

  async versions(cfg: CloudConnectedConfig, cloudId: string): Promise<{ version: string; published_at?: string | null }[]> {
    const body = await this.request<{ items: { version: string; published_at?: string | null }[] }>(
      cfg.url, 'GET', `/cloud/v1/market/listings/${encodeURIComponent(cloudId)}/versions`, { token: cfg.token },
    );
    return Array.isArray(body?.items) ? body.items : [];
  }

  async publish(
    cfg: CloudConnectedConfig,
    payload: Record<string, unknown>,
  ): Promise<{ id: string; slug?: string }> {
    return this.request(cfg.url, 'POST', '/cloud/v1/market/publish', { body: payload, token: cfg.token });
  }

  async subscribeSnapshot(
    cfg: CloudConnectedConfig,
    cloudId: string,
  ): Promise<{ content: unknown; mcp_dependencies?: unknown[]; current_version?: string }> {
    return this.request(cfg.url, 'POST', `/cloud/v1/market/listings/${encodeURIComponent(cloudId)}/subscribe`, {
      token: cfg.token,
      body: {},
    });
  }

  async rate(cfg: CloudConnectedConfig, cloudId: string, score: number): Promise<{ avg: number; count: number }> {
    return this.request(cfg.url, 'POST', `/cloud/v1/market/listings/${encodeURIComponent(cloudId)}/rating`, {
      body: { score },
      token: cfg.token,
    });
  }

  async comment(cfg: CloudConnectedConfig, cloudId: string, content: string): Promise<{ id: string }> {
    return this.request(cfg.url, 'POST', `/cloud/v1/market/listings/${encodeURIComponent(cloudId)}/comments`, {
      body: { content },
      token: cfg.token,
    });
  }

  async feedback(
    cfg: CloudConnectedConfig,
    cloudId: string,
    body: { title: string; content: string },
  ): Promise<{ id: string; status?: string }> {
    return this.request(cfg.url, 'POST', `/cloud/v1/market/listings/${encodeURIComponent(cloudId)}/feedback`, {
      body,
      token: cfg.token,
    });
  }

  async report(cfg: CloudConnectedConfig, cloudId: string, reason: string): Promise<{ ok: true }> {
    return this.request(cfg.url, 'POST', `/cloud/v1/market/listings/${encodeURIComponent(cloudId)}/report`, {
      body: { reason },
      token: cfg.token,
    });
  }

  async toggleFavorite(cfg: CloudConnectedConfig, cloudId: string): Promise<{ favorited: boolean }> {
    return this.request(cfg.url, 'POST', `/cloud/v1/market/listings/${encodeURIComponent(cloudId)}/favorite`, {
      body: {},
      token: cfg.token,
    });
  }

  /** 统一传输：超时 5s；非 2xx / 网络错都归一成 CLOUD_ERROR（message 带服务端原文）。 */
  private async request<T>(
    base: string,
    method: 'GET' | 'POST',
    path: string,
    options: { query?: Record<string, string | undefined>; body?: unknown; token?: string } = {},
  ): Promise<T> {
    const url = new URL(path, base);
    for (const [key, value] of Object.entries(options.query ?? {})) {
      if (value !== undefined && value !== '') url.searchParams.set(key, value);
    }
    const headers: Record<string, string> = { accept: 'application/json' };
    if (options.token) headers.authorization = `Bearer ${options.token}`;
    let init: RequestInit = { method, headers };
    if (options.body !== undefined) {
      headers['content-type'] = 'application/json';
      init = { ...init, body: JSON.stringify(options.body) };
    }
    let res: Response;
    try {
      res = await fetch(url, { ...init, signal: AbortSignal.timeout(TIMEOUT_MS) });
    } catch (error) {
      throw new ApiException('CLOUD_ERROR', `服务端市场不可达：${(error as Error).message}`, undefined, {
        url: url.toString(),
      });
    }
    const text = await res.text();
    let body: unknown = null;
    try {
      body = text ? JSON.parse(text) : null;
    } catch {
      body = null;
    }
    if (!res.ok) {
      const cloudMessage =
        (body as { error?: { message?: string } } | null)?.error?.message ??
        (typeof body === 'object' && body !== null && 'message' in (body as Record<string, unknown>)
          ? String((body as Record<string, unknown>).message)
          : '') ??
        '';
      throw new ApiException(
        'CLOUD_ERROR',
        cloudMessage ? `服务端市场错误：${cloudMessage}` : `服务端市场错误：HTTP ${res.status}`,
        undefined,
        { status: res.status, url: url.toString() },
      );
    }
    return body as T;
  }
}
