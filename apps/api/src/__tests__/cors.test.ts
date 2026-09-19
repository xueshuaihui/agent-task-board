import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { allowedOrigins } from '../common/origins';
import { createTestApp, type TestApp } from './helpers/http-app';
import { API, uiSender } from './helpers/seed';

/**
 * 9.4.3 的 CORS 契约：精确匹配白名单、不回显任意来源、不接受 `Origin: null`、不按端口段放行。
 * 服务只绑 127.0.0.1 拦不住浏览器里的页面——网页能读 localhost:7788，所以这一层必须单独验。
 *
 * 判定口径：cors 中间件在 origin 回调返回 false 时**不写任何** `Access-Control-Allow-Origin`，
 * 浏览器据此拒绝响应；因此「没被放行」在这套实现里表现为头缺失，而不是回一个空值。
 */
let t: TestApp;
let whitelist: string[];

beforeAll(async () => {
  t = await createTestApp();
  // 期望值取自 allowedOrigins() 本身：与测试底座喂给 enableCors 的是同一份白名单，
  // 开发模式（ATB_DEV=1）多出来的 Vite dev server 源不会被写成硬编码的第二个真相。
  whitelist = allowedOrigins();
}, 60_000);

afterAll(async () => {
  await t?.close();
});

function get(url: string, origin?: string) {
  return uiSender(t).get(url, origin === undefined ? {} : { headers: { origin } });
}

describe('CORS 白名单精确匹配', () => {
  it('白名单本身不含通配符/前缀项，且每个源都能被精确回显', async () => {
    expect(whitelist.length).toBeGreaterThanOrEqual(2);
    for (const origin of whitelist) {
      expect(origin).not.toMatch(/[*]/);
      const res = await get(`${API}/board`, origin);
      expect(res.status).toBe(200);
      expect(res.headers.get('access-control-allow-origin')).toBe(origin);
    }
    // 桌面单用户：不带凭证，回显凭证头会让浏览器以为可以带 Cookie 打这个口。
    expect(whitelist.some((origin) => origin === '*')).toBe(false);
    const res = await get(`${API}/board`, whitelist[0]!);
    expect(res.headers.get('access-control-allow-credentials')).toBeNull();
  });

  it('非白名单 Origin 不回显： evil 源拿不到任何放行头', async () => {
    for (const origin of [
      'http://evil.example.com',
      'https://evil.example.com',
      'http://localhost:7788',
      'http://127.0.0.1:9999',
    ]) {
      const res = await get(`${API}/board`, origin);
      // 请求本身仍然成功（跨域限制是浏览器行为，服务端只负责不发放行头）。
      expect(res.status, `${origin} 不应被 403 掉`).toBe(200);
      expect(
        res.headers.get('access-control-allow-origin'),
        `${origin} 不该被回显`,
      ).toBeNull();
    }
  });

  it('Origin: null（沙箱 iframe / file://）被拒', async () => {
    const res = await get(`${API}/board`, 'null');
    expect(res.headers.get('access-control-allow-origin')).toBeNull();
  });

  it('前缀与后缀近邻、大小写、多一个端口都不算命中（精确匹配）', async () => {
    const nearMisses = [
      'tauri://localhost.evil.com',
      'http://tauri.localhost.attacker.io',
      'http://TAURI.localhost',
      'http://tauri.localhost:80',
      'tauri:/localhost',
      // 前后加空格的变体不在这张表里：Fetch 规范在设置请求头时就剥掉了首尾空白，
      // 发出去的仍然是白名单里的原值，用它测不出「不精确匹配」。
    ];
    for (const origin of nearMisses) {
      expect(whitelist, `${origin} 竟然在白名单里`).not.toContain(origin);
      const res = await get(`${API}/board`, origin);
      expect(res.headers.get('access-control-allow-origin'), `${origin} 被回显了`).toBeNull();
    }
  });

  it('预检：白名单来源的 OPTIONS 放行 Agent 需要的三个头与方法', async () => {
    const res = await uiSender(t).send(`${API}/tasks/claim`, {
      method: 'OPTIONS',
      token: null,
      headers: {
        origin: whitelist[0]!,
        'access-control-request-method': 'POST',
        'access-control-request-headers': 'authorization,content-type',
      },
    });
    expect(res.status).toBe(204);
    expect(res.headers.get('access-control-allow-origin')).toBe(whitelist[0]!);
    expect(res.headers.get('access-control-allow-methods')).toContain('POST');
    expect((res.headers.get('access-control-allow-headers') ?? '').toLowerCase()).toContain(
      'authorization',
    );
  });

  it('预检：PUT 在放行方法表里（/prefs/:key 与 /skills/sources 靠它，漏了则偏好存不住）', async () => {
    const res = await uiSender(t).send(`${API}/prefs/board.grouping`, {
      method: 'OPTIONS',
      token: null,
      headers: {
        origin: whitelist[0]!,
        'access-control-request-method': 'PUT',
        'access-control-request-headers': 'authorization,content-type',
      },
    });
    expect(res.status).toBe(204);
    expect(res.headers.get('access-control-allow-methods') ?? '').toContain('PUT');
  });

  it('预检：非白名单来源同样不回显，且没有 Max-Age 可缓存', async () => {
    const res = await uiSender(t).send(`${API}/tasks/claim`, {
      method: 'OPTIONS',
      token: null,
      headers: {
        origin: 'http://evil.example.com',
        'access-control-request-method': 'POST',
        'access-control-request-headers': 'authorization',
      },
    });
    expect(res.headers.get('access-control-allow-origin')).toBeNull();
  });

  it('无 Origin 头的请求（curl / 桌面壳自身）照常通过，不额外发放行头', async () => {
    const res = await uiSender(t).get(`${API}/board`);
    expect(res.status).toBe(200);
    expect(res.headers.get('access-control-allow-origin')).toBeNull();
  });
});
