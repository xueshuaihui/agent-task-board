import { createHmac } from 'node:crypto';
import type { NextFunction, Request, Response } from 'express';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ApiException } from '../../contract/errors';
import { ArtifactSignService, SIGN_TTL_SECONDS } from '../artifact-sign.service';
import { SignedResourceMiddleware } from '../signed-resource.middleware';

/**
 * 13 章「资源型端点例外」：`<img>` / iframe 带不了请求头，只能把凭证放进 URL，
 * 但同一节又要求「不把 UI Token 放进查询参数（会进访问日志）」。
 * 这里验的就是这两条同时成立：能换到访问权限，且查询串里没有那个 Token。
 */

/** 故意写成非 hex、一眼可认的串，好让「签名 ≠ Token」这类断言不含糊。 */
const UI_TOKEN = `ui-${'c0ffee'.repeat(12)}`;
const ID_A = '0a1b2c3d-4e5f-4a7b-8c9d-0e1f2a3b4c5d';
const ID_B = '1a1b2c3d-4e5f-4a7b-8c9d-0e1f2a3b4c5e';

function queryOf(url: string): Record<string, string> {
  return Object.fromEntries(new URL(`http://127.0.0.1${url}`).searchParams);
}

function newService(): ArtifactSignService {
  process.env.ATB_UI_TOKEN = UI_TOKEN;
  return new ArtifactSignService();
}

function thrown(call: () => void): unknown {
  try {
    call();
  } catch (error) {
    return error;
  }
  return undefined;
}

function expectUnauthorized(call: () => void, message?: string): void {
  const error = thrown(call);
  expect(error).toBeInstanceOf(ApiException);
  const api = error as ApiException;
  expect(api.code).toBe('UNAUTHORIZED');
  expect(api.status).toBe(401);
  if (message) expect(api.message).toBe(message);
}

afterEach(() => {
  vi.useRealTimers();
});

describe('ArtifactSignService：60 秒一次性签名', () => {
  it('签出的 URL 有效期 60 秒，查询串只有 exp / n / s 三项', () => {
    const service = newService();
    const signed = service.sign(ID_A, 'raw');

    expect(SIGN_TTL_SECONDS).toBe(60);
    expect(signed.ttl_seconds).toBe(60);
    expect(signed.url.startsWith(`/api/v1/artifacts/${ID_A}/raw?`)).toBe(true);
    const remaining = new Date(signed.expires_at).getTime() - Date.now();
    expect(remaining).toBeGreaterThan(58_000);
    expect(remaining).toBeLessThanOrEqual(60_000);

    const query = queryOf(signed.url);
    expect(Object.keys(query).sort()).toEqual(['exp', 'n', 's']);
    expect(query.s).toMatch(/^[0-9a-f]{64}$/);
    expect(query.n).toMatch(/^[0-9a-f]{8,64}$/);
    expect(query.exp).toMatch(/^\d{1,12}$/);
  });

  it('UI Token 绝不出现在查询参数里，也不出现在签名字段里', () => {
    const service = newService();
    const signed = service.sign(ID_A, 'raw');
    const query = queryOf(signed.url);

    expect(signed.url).not.toContain(UI_TOKEN);
    expect(signed.url).not.toContain(encodeURIComponent(UI_TOKEN));
    expect(Object.values(query).some((value) => value.includes(UI_TOKEN))).toBe(false);
    expect(Object.keys(query).some((key) => /token|auth|key|secret/i.test(key))).toBe(false);
    // 签名是 HMAC 委托值，不是 Token 的任何一种编码。
    expect(query.s).not.toContain(UI_TOKEN);
    expect(query.s).not.toBe(createHmac('sha256', UI_TOKEN).update('').digest('hex'));
  });

  it('第二次核销必须失败：重放被拒（一次性）', () => {
    const service = newService();
    const query = queryOf(service.sign(ID_A, 'raw').url);

    expect(() => service.consume(ID_A, 'raw', query)).not.toThrow();
    expectUnauthorized(() => service.consume(ID_A, 'raw', query), '签名 URL 已使用');
    // 重放失败不会反过来把凭证「洗白」：第三次依旧拒绝。
    expectUnauthorized(() => service.consume(ID_A, 'raw', query), '签名 URL 已使用');
  });

  it('raw 与 thumbnail 各自独立签、独立核销', () => {
    const service = newService();
    const raw = queryOf(service.sign(ID_A, 'raw').url);
    const thumb = queryOf(service.sign(ID_A, 'thumbnail').url);
    expect(service.sign(ID_A, 'thumbnail').url.startsWith(`/api/v1/artifacts/${ID_A}/thumbnail?`)).toBe(true);

    // raw 用掉一次不影响 thumbnail：两个 variant 的核销彼此独立。
    expect(() => service.consume(ID_A, 'raw', raw)).not.toThrow();
    expect(() => service.consume(ID_A, 'thumbnail', thumb)).not.toThrow();
  });

  it('签给 raw 的凭证换不到 thumbnail，反之亦然（kind 参与签名）', () => {
    const service = newService();
    const raw = queryOf(service.sign(ID_A, 'raw').url);
    const thumb = queryOf(service.sign(ID_A, 'thumbnail').url);
    expectUnauthorized(() => service.consume(ID_A, 'thumbnail', raw), '签名不合法');
    expectUnauthorized(() => service.consume(ID_A, 'raw', thumb), '签名不合法');
  });

  it('超过 60 秒即失效', () => {
    const service = newService();
    vi.useFakeTimers();
    const live = queryOf(service.sign(ID_A, 'raw').url);
    expect(() => service.consume(ID_A, 'raw', live)).not.toThrow();

    const later = queryOf(service.sign(ID_B, 'raw').url);
    vi.setSystemTime(new Date(Date.now() + (SIGN_TTL_SECONDS + 1) * 1000));
    expectUnauthorized(() => service.consume(ID_B, 'raw', later), '签名 URL 已过期');
  });

  it('签名绑定产物 id：A 的凭证打不开 B', () => {
    const service = newService();
    const query = queryOf(service.sign(ID_A, 'raw').url);
    expectUnauthorized(() => service.consume(ID_B, 'raw', query), '签名不合法');
  });

  it('篡改 / 缺项 / 形状不符一律 401，不区分原因以免给探测留口子', () => {
    const service = newService();
    const query = queryOf(service.sign(ID_A, 'raw').url);

    expectUnauthorized(() => service.consume(ID_A, 'raw', { ...query, s: '0'.repeat(64) }), '签名不合法');
    expectUnauthorized(() => service.consume(ID_A, 'raw', { ...query, n: 'zzzzzzzz' }), '缺少签名凭证');
    expectUnauthorized(() => service.consume(ID_A, 'raw', { ...query, exp: 'abc' }), '缺少签名凭证');
    expectUnauthorized(() => service.consume(ID_A, 'raw', { n: query.n, s: query.s }), '缺少签名凭证');
    expectUnauthorized(() => service.consume(ID_A, 'raw', {}), '缺少签名凭证');
  });

  it('只有 UI 会话密钥能签出可用凭证：换密钥签的立刻 401（Agent Token 签不出来）', () => {
    const signer = new ArtifactSignService();
    process.env.ATB_UI_TOKEN = `agent-${'deadbeef'.repeat(8)}`;
    const forged = queryOf(signer.sign(ID_A, 'raw').url);
    const service = newService();
    expectUnauthorized(() => service.consume(ID_A, 'raw', forged), '签名不合法');
  });

  it('密钥未注入时拒绝签发，而不是签出一个弱签名', () => {
    const saved = process.env.ATB_UI_TOKEN;
    delete process.env.ATB_UI_TOKEN;
    try {
      const error = thrown(() => new ArtifactSignService().sign(ID_A, 'raw'));
      expect((error as ApiException).code).toBe('INTERNAL');
      expect((error as ApiException).status).toBe(500);
    } finally {
      process.env.ATB_UI_TOKEN = saved;
    }
  });

  it('一次性集合随过期回收，不会无界增长', () => {
    const service = newService();
    const consumed = Reflect.get(service, 'consumed') as Map<string, number>;
    for (let index = 0; index < 20; index += 1) {
      const id = `00000000-0000-4000-8000-${String(index).padStart(12, '0')}`;
      service.consume(id, 'raw', queryOf(service.sign(id, 'raw').url));
    }
    expect(consumed.size).toBe(20);

    vi.useFakeTimers();
    vi.setSystemTime(new Date(Date.now() + (SIGN_TTL_SECONDS + 5) * 1000));
    service.consume(ID_A, 'raw', queryOf(service.sign(ID_A, 'raw').url));
    expect(consumed.size).toBe(1);
  });
});

describe('SignedResourceMiddleware：签名换凭证', () => {
  interface FakeRes {
    code: number | undefined;
    body: unknown;
  }

  function makeRes(state: FakeRes): Response {
    const response: Partial<Response> = {
      status(code: number) {
        state.code = code;
        return response as Response;
      },
      json(body: unknown) {
        state.body = body;
        return response as Response;
      },
    };
    return response as Response;
  }

  function makeRequest(url: string, query: Record<string, string>, id: string): Request {
    return {
      originalUrl: url,
      url,
      params: { id },
      query,
      headers: {} as Record<string, string>,
    } as unknown as Request;
  }

  function rawUrl(id: string, query: Record<string, string>, kind = 'raw'): string {
    return `/api/v1/artifacts/${id}/${kind}?${new URLSearchParams(query).toString()}`;
  }

  function run(service: ArtifactSignService, req: Request): { res: FakeRes; next: ReturnType<typeof vi.fn> } {
    const middleware = new SignedResourceMiddleware(service);
    const res: FakeRes = { code: undefined, body: undefined };
    const next = vi.fn();
    middleware.use(req, makeRes(res), next as unknown as NextFunction);
    return { res, next };
  }

  it('合法签名：放行到守卫之前注入 Authorization，查询串依旧不含 UI Token', () => {
    const service = newService();
    const query = queryOf(service.sign(ID_A, 'raw').url);
    const req = makeRequest(rawUrl(ID_A, query), query, ID_A);
    const { next } = run(service, req);

    expect(next).toHaveBeenCalledTimes(1);
    expect(req.headers.authorization).toBe(`Bearer ${UI_TOKEN}`);
    // Token 只进请求头：查询参数从头到尾只有那三项。
    expect(Object.keys(req.query as object).sort()).toEqual(['exp', 'n', 's']);
    expect(JSON.stringify(req.query)).not.toContain(UI_TOKEN);
  });

  it('重放到中间件这一层就已经 401，且不会给它注入凭证', () => {
    const service = newService();
    const query = queryOf(service.sign(ID_A, 'raw').url);
    const url = rawUrl(ID_A, query);

    expect(run(service, makeRequest(url, query, ID_A)).next).toHaveBeenCalledTimes(1);
    const { res, next } = run(service, makeRequest(url, query, ID_A));
    expect(next).not.toHaveBeenCalled();
    expect(res.code).toBe(401);
    expect(res.body).toMatchObject({ error: { code: 'UNAUTHORIZED' } });
  });

  it('不带签名参数的请求原样交给守卫按 Authorization 判', () => {
    const service = newService();
    const req = makeRequest(`/api/v1/artifacts/${ID_A}/raw`, {}, ID_A);
    const { next } = run(service, req);
    expect(next).toHaveBeenCalledTimes(1);
    expect(req.headers.authorization).toBeUndefined();
  });

  it('非资源型端点（元信息 / diff）即使带着签名参数也不换凭证', () => {
    const service = newService();
    const query = queryOf(service.sign(ID_A, 'raw').url);
    for (const base of [`/api/v1/artifacts/${ID_A}`, `/api/v1/artifacts/${ID_A}/diff`]) {
      const req = makeRequest(`${base}?${new URLSearchParams(query).toString()}`, query, ID_A);
      const { next } = run(service, req);
      expect(next).toHaveBeenCalledTimes(1);
      expect(req.headers.authorization).toBeUndefined();
    }
    // 没被中间件消费掉的那份签名，仍然只对自己的 variant 有效。
    expect(() => service.consume(ID_A, 'raw', query)).not.toThrow();
  });

  it('签名形状合法但已失效时，按 13 章错误体返回 401', () => {
    const service = newService();
    const req = makeRequest(
      rawUrl(ID_A, { exp: '1', n: 'abcdef01', s: '0'.repeat(64) }, 'thumbnail'),
      { exp: '1', n: 'abcdef01', s: '0'.repeat(64) },
      ID_A,
    );
    const { res, next } = run(service, req);
    expect(next).not.toHaveBeenCalled();
    expect(res.code).toBe(401);
    expect((res.body as { error: { code: string } }).error.code).toBe('UNAUTHORIZED');
  });
});
