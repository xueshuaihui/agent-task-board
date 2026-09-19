import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { applyDiShim } from './nest-di-shim';
import { AppModule } from '../../app.module';
import { ApiExceptionFilter } from '../../infra/api-exception.filter';
import { applyMigrations } from '../../infra/bootstrap';
import { PrismaService } from '../../infra/prisma.service';

/**
 * 真 HTTP 集成测试底座：临时 CLOUD_DATA_DIR + 真实 AppModule + 127.0.0.1:0 监听。
 * 与 apps/api 的 http-app helper 同一套约定：端口 0 随机、管线照抄 main.ts、每文件一库。
 */
export interface TestApp {
  dir: string;
  origin: string;
  app: NestExpressApplication;
  prisma: PrismaService;
  close(): Promise<void>;
}

export interface Res<T = any> {
  status: number;
  body: T;
  text: string;
  headers: Headers;
}

export interface Sender {
  get<T = any>(url: string): Promise<Res<T>>;
  post<T = any>(url: string, body?: unknown, token?: string | null): Promise<Res<T>>;
  del<T = any>(url: string, token?: string | null): Promise<Res<T>>;
}

export function errorCode(res: Res): string {
  return (res.body as { error?: { code?: string } })?.error?.code ?? '';
}

export function request(app: TestApp, token: string): Sender {
  return sender(app, token);
}

export function anonSender(app: TestApp): Sender {
  return sender(app);
}

function sender(app: TestApp, token?: string | null): Sender {
  const send = async (url: string, method: string, body?: unknown): Promise<Res> => {
    const res = await fetch(`${app.origin}${url}`, {
      method,
      headers: {
        ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await res.text();
    let parsed: unknown = undefined;
    try {
      parsed = text ? JSON.parse(text) : undefined;
    } catch {
      parsed = undefined;
    }
    return { status: res.status, body: parsed as any, text, headers: res.headers };
  };
  return {
    get: (url) => send(url, 'GET'),
    post: (url, body, tok) => send(url, 'POST', body),
    del: (url, tok) => send(url, 'DELETE'),
  };
}

export async function createTestApp(): Promise<TestApp> {
  applyDiShim();
  const dir = mkdtempSync(path.join(tmpdir(), 'atb-cloud-'));
  process.env.CLOUD_DATA_DIR = dir;
  process.env.CLOUD_JWT_SECRET = 'test-secret-for-vitest';
  delete process.env.CLOUD_CORS_ORIGINS;

  const prisma = new PrismaService();
  await applyMigrations(prisma);

  const app = await NestFactory.create<NestExpressApplication>(AppModule, {
    logger: ['error'],
  });
  app.useBodyParser('json', { limit: '2mb' });
  app.set('query parser', 'extended');
  app.useGlobalFilters(new ApiExceptionFilter());
  app.enableCors({ origin: true });

  await app.listen(0, '127.0.0.1');
  const address = app.getHttpServer().address();
  const port = typeof address === 'object' && address ? address.port : 0;
  const t: TestApp = {
    dir,
    origin: `http://127.0.0.1:${port}`,
    app,
    prisma: app.get(PrismaService, { strict: false }),
    close: async () => {
      await app.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
  return t;
};
