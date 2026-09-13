import { randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { expect } from 'vitest';
import { AppModule } from '../../app.module';
import { allowedOrigins } from '../../common/origins';
import { LeaseService } from '../../agent/lease.service';
import { ApiExceptionFilter } from '../../infra/api-exception.filter';
import { applyMigrations } from '../../infra/bootstrap';
import { PrismaService } from '../../infra/prisma.service';
import { applyDiShim } from './nest-di-shim';

/**
 * 真 HTTP 集成测试的公共底座：临时 SQLite + 真实 AppModule + 127.0.0.1:0 上的一次性监听。
 *
 * 三点约定：
 * 1. 端口 0（内核随机）且 host 写死 127.0.0.1 —— 15 章/验收 2 的「只绑回环」在测试里同样成立，
 *    绝不占用 7788，也不与并行 agent 的开发实例冲突。
 * 2. 请求管线（body parser / query parser / 全局异常过滤器 / CORS）照抄 `src/main.ts`：
 *    这些装配语句在 main.ts 里而不是 AppModule 里，测试不复制一遍就等于没测。
 * 3. 每个测试文件一个进程一个库（vitest 默认 forks + isolate），互不干扰。
 */
export interface TestApp {
  /** 临时数据目录（atb.db / artifacts / backups 都在这下面）。 */
  dir: string;
  /** `http://127.0.0.1:{随机端口}` */
  origin: string;
  /** 与 `ATB_UI_TOKEN` 同一个值：UI 凭证组的 Bearer。 */
  uiToken: string;
  app: NestExpressApplication;
  prisma: PrismaService;
  /** 关掉 30 秒租约扫描后的显式入口：过期回收用手动调用来测，不依赖真实定时器。 */
  leases: LeaseService;
  close(): Promise<void>;
}

export interface Res<T = any> {
  status: number;
  body: T;
  text: string;
  headers: Headers;
}

export interface SendOptions {
  method?: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE' | 'OPTIONS';
  /** Bearer 值；不传就不发 Authorization 头。 */
  token?: string | null;
  /** JSON 请求体（与 raw 互斥）。 */
  body?: unknown;
  /** 原样发送的请求体，用于 multipart 之类自带 Content-Type 的场合。 */
  raw?: NonNullable<RequestInit['body']>;
  headers?: Record<string, string>;
  /** 拼在 origin 之前的绝对 URL（测根路径 404 与签名 URL 用）。 */
  absolute?: string;
  /** 跳过 13 章错误体形状断言（MCP 传输层的 JSON-RPC 错误不归它管）。 */
  skipEnvelopeCheck?: boolean;
}

export interface Sender {
  get<T = any>(url: string, options?: SendOptions): Promise<Res<T>>;
  post<T = any>(url: string, body?: unknown, options?: SendOptions): Promise<Res<T>>;
  patch<T = any>(url: string, body?: unknown, options?: SendOptions): Promise<Res<T>>;
  del<T = any>(url: string, body?: unknown, options?: SendOptions): Promise<Res<T>>;
  send<T = any>(url: string, options?: SendOptions): Promise<Res<T>>;
}

const MCP_ACCEPT = 'application/json, text/event-stream';

export async function createTestApp(): Promise<TestApp> {
  applyDiShim();

  const dir = mkdtempSync(path.join(tmpdir(), 'atb-it-'));
  const previous = { dataDir: process.env.ATB_DATA_DIR, uiToken: process.env.ATB_UI_TOKEN };
  process.env.ATB_DATA_DIR = dir;
  // 生产由 Tauri 注入；这里等价地给一个 32 字节随机值，绕开 dev-ui-token 落盘分支。
  process.env.ATB_UI_TOKEN = randomBytes(32).toString('hex');
  applyMigrations();

  const prisma = new PrismaService();
  const app = await NestFactory.create<NestExpressApplication>(AppModule, {
    logger: false,
    bodyParser: false,
  });
  app.useBodyParser('json', { limit: '2mb' });
  app.useBodyParser('urlencoded', { extended: true, limit: '2mb' });
  app.set('query parser', 'extended');
  app.useGlobalFilters(new ApiExceptionFilter());

  // main.ts 的 CORS 原样复制：白名单同样来自 allowedOrigins()，不各写一份。
  const allow = new Set(allowedOrigins());
  app.enableCors({
    origin(origin, callback) {
      if (!origin) return callback(null, true);
      return callback(null, allow.has(origin));
    },
    methods: ['GET', 'POST', 'PATCH', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Authorization', 'Content-Type', 'Accept'],
    maxAge: 600,
    credentials: false,
  });

  await app.init();
  await app.listen(0, '127.0.0.1');
  const address = app.getHttpServer().address();
  if (!address || typeof address === 'string') throw new Error('未能取到随机端口');
  const origin = `http://127.0.0.1:${address.port}`;

  const leases = app.get(LeaseService);
  // 30 秒的扫描定时器虽然 unref 了，但会把「过期未回收」这条分支的判定时刻变成随机的。
  // 测试统一改成手动调 `reclaimExpired()`，见 lease-invalidation.test.ts。
  leases.stopSweeper();

  return {
    dir,
    origin,
    uiToken: process.env.ATB_UI_TOKEN,
    app,
    prisma,
    leases,
    close: async () => {
      leases.stopSweeper();
      await app.close();
      await prisma.$disconnect();
      rmSync(dir, { force: true, recursive: true });
      restoreEnv(previous);
    },
  };
}

function restoreEnv(previous: { dataDir?: string; uiToken?: string }): void {
  if (previous.dataDir === undefined) delete process.env.ATB_DATA_DIR;
  else process.env.ATB_DATA_DIR = previous.dataDir;
  if (previous.uiToken === undefined) delete process.env.ATB_UI_TOKEN;
  else process.env.ATB_UI_TOKEN = previous.uiToken;
}

export function request(t: TestApp, token: string | null = null): Sender {
  async function send<T>(url: string, options: SendOptions = {}): Promise<Res<T>> {
    const headers: Record<string, string> = { accept: 'application/json', ...options.headers };
    const bearer = options.token === undefined ? token : options.token;
    if (bearer) headers.authorization = `Bearer ${bearer}`;

    const init: RequestInit = { method: options.method ?? 'GET', headers };
    if (options.raw !== undefined) init.body = options.raw;
    else if (options.body !== undefined) {
      headers['content-type'] = 'application/json';
      init.body = JSON.stringify(options.body);
    }

    const target = options.absolute ?? `${t.origin}${url}`;
    const response = await fetch(target, init);
    const text = await response.text();
    let body: unknown = null;
    if (text) {
      try {
        body = JSON.parse(text);
      } catch {
        body = null;
      }
    }
    const result = {
      status: response.status,
      body: body as T,
      text,
      headers: response.headers,
    };
    if (response.status >= 400 && !options.skipEnvelopeCheck) assertErrorEnvelope(url, result);
    return result as Res<T>;
  }

  return {
    send,
    get: (url, options) => send(url, { ...options, method: 'GET' }),
    post: (url, body, options) => send(url, { ...options, method: 'POST', body }),
    patch: (url, body, options) => send(url, { ...options, method: 'PATCH', body }),
    del: (url, body, options) => send(url, { ...options, method: 'DELETE', body }),
  };
}

/** 13 章：所有非 2xx 出口都是 `{ error: { code, message, ...上下文 } }`。 */
export function assertErrorEnvelope(url: string, res: Res): void {
  const envelope = (res.body ?? {}) as { error?: { code?: unknown; message?: unknown } };
  expect(
    envelope.error,
    `${url} → ${res.status} 的错误体不是 13 章的 { error: { code, message } }：${res.text.slice(0, 200)}`,
  ).toBeTypeOf('object');
  expect(envelope.error?.code, `${url} → ${res.status} 缺 error.code`).toBeTypeOf('string');
  expect(envelope.error?.message, `${url} → ${res.status} 缺 error.message`).toBeTypeOf('string');
}

export function errorCode(res: Res): string | undefined {
  return (res.body as { error?: { code?: string } })?.error?.code;
}

export function errorMessage(res: Res): string | undefined {
  return (res.body as { error?: { message?: string } })?.error?.message;
}

/** 12 章：MCP 端点要求客户端同时接受两种媒体类型，缺 accept 头是传输层拒绝。 */
export function mcpAccept(): Record<string, string> {
  return { accept: MCP_ACCEPT, 'content-type': 'application/json' };
}

export function accept(value: string): Record<string, string> {
  return { accept: value };
}
