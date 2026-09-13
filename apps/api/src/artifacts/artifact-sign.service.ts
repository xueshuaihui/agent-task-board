import { randomBytes, createHmac } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import { ApiException } from '../contract/errors';
import { constantTimeEqual } from '../common/ui-token';

export type SignedKind = 'raw' | 'thumbnail';

/** 13 章：一次性签名 URL 的有效期。前端拿到就立刻用，不做缓存。 */
export const SIGN_TTL_SECONDS = 60;

interface ParsedGrant {
  artifactId: string;
  kind: SignedKind;
  group: string;
  expiresAt: number;
  nonce: string;
  signature: string;
}

/**
 * 资源型端点（`<img>` / iframe）带不了请求头（13 章「资源型端点例外」），只能把凭证放进 URL。
 * 这里放的不是 UI Token 本身而是它的 HMAC 委托：密钥由 UI Token 派生，UI Token 不出现在查询串里，
 * 也就不会进访问日志。签名内含凭证组 `grp`，Agent Token 签不出、也换不到 UI 侧的其它接口。
 *
 * 一次性靠进程内的 nonce 集合实现：sidecar 是单进程（9.4），重启后旧 URL 自然失效，
 * 不需要为此建表——表也不能建（schema 对我冻结）。
 */
@Injectable()
export class ArtifactSignService {
  private readonly consumed = new Map<string, number>();

  private key(): string {
    const secret = process.env.ATB_UI_TOKEN ?? '';
    if (secret.length < 32) {
      throw new ApiException('INTERNAL', '签名密钥不可用：UI 会话 Token 未注入');
    }
    return secret;
  }

  private mac(payload: string): string {
    return createHmac('sha256', this.key()).update(payload).digest('hex');
  }

  sign(artifactId: string, kind: SignedKind): { url: string; expires_at: string; ttl_seconds: number } {
    const nonce = randomBytes(12).toString('hex');
    // 查询串里的 exp 只有秒精度，核销时是按 `exp * 1000` 反推 payload 的，
    // 所以签名也必须用同一个「整秒」值：带着毫秒尾巴签出去，每次核销都是 401。
    const expiresAt = Math.floor((Date.now() + SIGN_TTL_SECONDS * 1000) / 1000) * 1000;
    const payload = this.payload(artifactId, kind, expiresAt, nonce);
    const signature = this.mac(payload);
    const query = new URLSearchParams({
      exp: String(expiresAt / 1000),
      n: nonce,
      s: signature,
    });
    return {
      url: `/api/v1/artifacts/${artifactId}/${kind}?${query.toString()}`,
      expires_at: new Date(expiresAt).toISOString(),
      ttl_seconds: SIGN_TTL_SECONDS,
    };
  }

  private payload(artifactId: string, kind: SignedKind, expiresAt: number, nonce: string): string {
    return `v1|${artifactId}|${kind}|grp=ui|exp=${expiresAt}|n=${nonce}`;
  }

  /** 校验并核销：过期、签名不符、重放都一律 401，不区分原因以免给探测留口子。 */
  consume(artifactId: string, kind: SignedKind, query: Record<string, unknown>): void {
    const parsed = this.parse(artifactId, kind, query);
    if (!parsed) throw new ApiException('UNAUTHORIZED', '缺少签名凭证');
    const { expiresAt, nonce, signature } = parsed;
    const expected = this.mac(this.payload(artifactId, kind, expiresAt, nonce));
    if (!constantTimeEqual(expected, signature)) {
      throw new ApiException('UNAUTHORIZED', '签名不合法');
    }
    if (expiresAt < Date.now()) {
      throw new ApiException('UNAUTHORIZED', '签名 URL 已过期');
    }
    this.sweep();
    const grantKey = `${kind}:${artifactId}:${nonce}`;
    if (this.consumed.has(grantKey)) {
      throw new ApiException('UNAUTHORIZED', '签名 URL 已使用');
    }
    this.consumed.set(grantKey, expiresAt);
  }

  /** 只验不核销：元信息接口用它回答「这个 URL 还能用吗」，签发时不需要。 */
  private parse(
    artifactId: string,
    kind: SignedKind,
    query: Record<string, unknown>,
  ): ParsedGrant | null {
    const exp = String(query.exp ?? '');
    const nonce = String(query.n ?? '');
    const signature = String(query.s ?? '');
    if (!/^\d{1,12}$/.test(exp) || !/^[0-9a-f]{8,64}$/.test(nonce)) return null;
    if (!/^[0-9a-f]{64}$/.test(signature)) return null;
    return {
      artifactId,
      kind,
      group: 'ui',
      expiresAt: Number(exp) * 1000,
      nonce,
      signature,
    };
  }

  /** 惰性回收：一次性的东西过期后就再也不会命中，没必要为它注册定时器（那是 jobs 的地盘）。 */
  private sweep(): void {
    const now = Date.now();
    for (const [key, expiresAt] of this.consumed) {
      if (expiresAt < now) this.consumed.delete(key);
    }
  }
}
