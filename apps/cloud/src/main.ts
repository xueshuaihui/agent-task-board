import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { AppModule } from './app.module';
import { corsOrigins, dataDir, jwtSecret, port } from './common/paths';
import { ApiExceptionFilter } from './infra/api-exception.filter';
import { applyMigrations } from './infra/bootstrap';
import { PrismaService } from './infra/prisma.service';

/**
 * 服务端市场服务：面向公网部署，绑 0.0.0.0（与桌面 sidecar 只绑回环相反）。
 * 环境变量：CLOUD_PORT（默认 7789）、CLOUD_DATA_DIR、CLOUD_JWT_SECRET、CLOUD_CORS_ORIGINS。
 */
async function bootstrap(): Promise<void> {
  const app = await NestFactory.create<NestExpressApplication>(AppModule, {
    logger: ['log', 'warn', 'error'],
  });

  app.useBodyParser('json', { limit: '2mb' });
  app.useBodyParser('urlencoded', { extended: true, limit: '2mb' });
  app.set('query parser', 'extended');
  app.useGlobalFilters(new ApiExceptionFilter());

  // CORS：默认放行任意来源（公开市场）；生产建议 CLOUD_CORS_ORIGINS 精确列出桌面端/网页端来源。
  const allow = corsOrigins();
  app.enableCors({
    origin: allow === '*' ? true : (origin, callback) => callback(null, !origin || allow.includes(origin)),
    methods: ['GET', 'POST', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Authorization', 'Content-Type', 'Accept'],
    maxAge: 600,
    credentials: false,
  });

  app.enableShutdownHooks();

  const prisma = app.get(PrismaService, { strict: false });
  const applied = await applyMigrations(prisma);
  if (applied.length > 0) console.log(`[cloud] 已应用迁移 ${applied.join(', ')}`);
  if (!jwtSecret()) {
    console.warn('[cloud] 未配置 CLOUD_JWT_SECRET，登录/签发将被拒绝；生产必须显式配置');
  }

  const listenPort = port();
  await app.listen(listenPort, '0.0.0.0');
  console.log(`[cloud] 服务端市场就绪：http://0.0.0.0:${listenPort}（数据目录 ${dataDir()}）`);
}

void bootstrap().catch((error: unknown) => {
  console.error('[cloud] 启动失败', error);
  process.exit(1);
});
