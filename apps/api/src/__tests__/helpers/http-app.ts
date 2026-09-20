import { randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Global, Module, type Type } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { expect } from 'vitest';
import { AppModule } from '../../app.module';
import { corsOptions } from '../../common/cors';
import { LEASE_SWEEP_OPTIONS, LeaseService } from '../../agent/lease.service';
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
 * 2. 请求管线（body parser / query parser / 全局异常过滤器 / CORS）与 `src/main.ts` 同源：
 *    这些装配语句在 main.ts 里而不是 AppModule 里，测试不复制一遍就等于没测；
 *    CORS 是唯一一份 `common/cors.ts` 的配置，两处不会各写一份而漂移。
 * 3. 每个测试文件一个进程一个库（vitest 默认 forks + isolate），互不干扰。
 */
export interface TestApp {
  /** 临时数据目录（jarvis.db / artifacts / backups 都在这下面）。 */
  dir: string;
  /** `http://127.0.0.1:{随机端口}` */
  origin: string;
  /** 与 `ATB_UI_TOKEN` 同一个值：UI 凭证组的 Bearer。 */
  uiToken: string;
  app: NestExpressApplication;
  prisma: PrismaService;
  /** 容器里那一个 LeaseService：手工回收用 `reclaimExpired()`，定时器状态读下面两个快照。 */
  leases: LeaseService;
  /**
   * `app.init()` 之后、helper 手工停表之前抓的装配快照。
   * `running: true` 就是「onModuleInit 真的起了那个后台扫描」的证据；
   * `intervalMs` 则锁住生产口径（不注入 options 即 4.3.2 的 30 秒）。
   */
  bootedSweeper: { running: boolean; intervalMs: number };
  /** 只关 Nest 应用（跑 onModuleDestroy），临时目录与 Prisma 连接都留着：优雅退出用例要在这之后继续读写库。 */
  closeApp(): Promise<void>;
  close(): Promise<void>;
}

export interface CreateTestAppOptions {
  /**
   * 覆盖后台租约扫描的周期（毫秒），走的是生产的 `ATB_LEASE_SWEEP_OPTIONS` 注入点。
   * 不传即 helper 照旧把定时器停掉，用例手工调 `reclaimExpired()`；传了就让它一直跑着，
   * 用来验「应用启动后扫描自己会动」（验收 13）。
   */
  leaseSweepIntervalMs?: number;
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
  put<T = any>(url: string, body?: unknown, options?: SendOptions): Promise<Res<T>>;
  patch<T = any>(url: string, body?: unknown, options?: SendOptions): Promise<Res<T>>;
  del<T = any>(url: string, body?: unknown, options?: SendOptions): Promise<Res<T>>;
  send<T = any>(url: string, options?: SendOptions): Promise<Res<T>>;
}

const MCP_ACCEPT = 'application/json, text/event-stream';

export async function createTestApp(options: CreateTestAppOptions = {}): Promise<TestApp> {
  applyDiShim();

  const dir = mkdtempSync(path.join(tmpdir(), 'atb-it-'));
  const previous = { dataDir: process.env.ATB_DATA_DIR, uiToken: process.env.ATB_UI_TOKEN };
  process.env.ATB_DATA_DIR = dir;
  // 生产由 Tauri 注入；这里等价地给一个 32 字节随机值，绕开 dev-ui-token 落盘分支。
  process.env.ATB_UI_TOKEN = randomBytes(32).toString('hex');
  applyMigrations();

  const prisma = new PrismaService();
  const app = await NestFactory.create<NestExpressApplication>(rootModule(options), {
    logger: false,
    bodyParser: false,
  });
  app.useBodyParser('json', { limit: '2mb' });
  app.useBodyParser('urlencoded', { extended: true, limit: '2mb' });
  app.set('query parser', 'extended');
  app.useGlobalFilters(new ApiExceptionFilter());

  app.enableCors(corsOptions());

  await app.init();
  await app.listen(0, '127.0.0.1');
  const address = app.getHttpServer().address();
  if (!address || typeof address === 'string') throw new Error('未能取到随机端口');
  const origin = `http://127.0.0.1:${address.port}`;

  const leases = app.get(LeaseService);
  // 先抓装配快照再动定时器：这一步之后 helper 停不停表，都不影响「onModuleInit 起了什么」的结论。
  const bootedSweeper = { running: leases.sweeperRunning, intervalMs: leases.sweeperIntervalMs };
  // 默认路径仍然手工停表：30 秒的扫描会把「过期未回收」这条分支的判定时机变成随机的，
  // 其余用例统一手动调 `reclaimExpired()`（见 lease-invalidation.test.ts）。
  // 传了 leaseSweepIntervalMs 就绝不停——停了这个用例测的就只是 helper 了。
  const keepSweeper = options.leaseSweepIntervalMs !== undefined;
  if (!keepSweeper) leases.stopSweeper();

  let appClosed = false;
  const closeApp = async (): Promise<void> => {
    if (appClosed) return;
    appClosed = true;
    // 不调 stopSweeper()：表要由 onModuleDestroy 自己停。
    await app.close();
  };

  return {
    dir,
    origin,
    uiToken: process.env.ATB_UI_TOKEN,
    app,
    prisma,
    leases,
    bootedSweeper,
    closeApp,
    close: async () => {
      if (!keepSweeper) leases.stopSweeper();
      await closeApp();
      await prisma.$disconnect();
      rmSync(dir, { force: true, recursive: true });
      restoreEnv(previous);
    },
  };
}

/**
 * 覆盖扫描周期用的根模块：`@Global()` 的导出会被 Nest 绑进容器里每个模块的依赖树，
 * 所以包一层根模块就能让 AgentModule 里的 `@Inject(LEASE_SWEEP_OPTIONS)` 拿到值，
 * 而生产的 `AppModule` / `AgentModule` 一行都不必改——测试装的仍是那棵真的模块树。
 */
function rootModule(options: CreateTestAppOptions): Type<unknown> {
  const { leaseSweepIntervalMs } = options;
  if (leaseSweepIntervalMs === undefined) return AppModule as unknown as Type<unknown>;

  class SweeperTunedRoot {}
  Module({
    imports: [AppModule],
    providers: [
      { provide: LEASE_SWEEP_OPTIONS, useValue: { intervalMs: leaseSweepIntervalMs } },
    ],
    exports: [LEASE_SWEEP_OPTIONS],
  })(SweeperTunedRoot);
  Global()(SweeperTunedRoot);
  return SweeperTunedRoot as unknown as Type<unknown>;
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
    put: (url, body, options) => send(url, { ...options, method: 'PUT', body }),
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
