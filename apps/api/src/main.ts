import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { AppModule } from './app.module';
import { corsOptions } from './common/cors';
import { dataDir, port } from './common/paths';
import { resolveUiToken } from './common/ui-token';
import { appVersion } from './common/version';
import { ApiExceptionFilter } from './infra/api-exception.filter';
import { applyMigrations } from './infra/bootstrap';
import { sharedAppLogger } from './infra/logger';
import { SettingsService } from './infra/settings.service';

/** 只绑回环，不提供改绑入口（20.13：任何情况下不监听 0.0.0.0）。 */
const LISTEN_HOST = '127.0.0.1';

/**
 * stdout 只承载 `ATB_READY` 一行（9.4.1 第 4 步）：主进程按行读它来确认端口，
 * 多一个字符都可能把「启动失败」误判出来。Nest 默认 logger 直接写 stdout，
 * 所以下面所有日志都改走 winston（文件 + dev 才进 stderr）。
 */
const ready = (listenPort: number): void => {
  process.stdout.write(
    `ATB_READY ${JSON.stringify({ port: listenPort, pid: process.pid, version: appVersion })}\n`,
  );
};

async function bootstrap(): Promise<void> {
  const logger = sharedAppLogger();
  const applied = applyMigrations(logger);
  logger.log(`数据目录 ${dataDir()}，迁移水位 ${applied.length > 0 ? applied.join(',') : '无变化'}`, 'boot');

  // UI 会话 Token：生产由 Tauri 注入；开发模式退化为本机 0600 文件（9.4.1）。
  process.env.ATB_UI_TOKEN = resolveUiToken();

  const app = await NestFactory.create<NestExpressApplication>(AppModule, {
    logger,
    bodyParser: false,
  });
  app.useLogger(logger);

  // 请求体上限：任务是文本为主，2 MB 足够；产物上传另有 multipart 限额（20.6）。
  app.useBodyParser('json', { limit: '2mb' });
  app.useBodyParser('urlencoded', { extended: true, limit: '2mb' });

  // Express 5 把默认值从 `extended` 改成了 `simple`，方括号键（20.7 的
  // `custom_fields[key]=v`）就不再解析成对象了，这里显式设回来。
  app.set('query parser', 'extended');
  app.useGlobalFilters(new ApiExceptionFilter());

  app.enableCors(corsOptions());

  // 未捕获异常一律记一条 error 后交还主进程重启 sidecar，不留僵尸监听。
  process.on('uncaughtException', (error) => {
    logger.error(`未捕获异常：${error.stack ?? error.message}`, undefined, 'boot');
    void app.close().finally(() => process.exit(1));
  });
  process.on('unhandledRejection', (reason) => {
    logger.error(`未处理的 Promise 拒绝：${String(reason)}`, undefined, 'boot');
  });

  app.enableShutdownHooks();

  // transport 建在容器之前，那时读不到设置；库里的保留天数在这里补上，之后由设置接口热更。
  logger.applyRetentionDays(
    await app.get(SettingsService, { strict: false }).get('log_retention_days'),
  );

  const listenPort = port();
  await app.listen(listenPort, LISTEN_HOST);
  logger.log(`sidecar 就绪：http://${LISTEN_HOST}:${listenPort}`, 'boot');
  ready(listenPort);
}

void bootstrap().catch((error: unknown) => {
  const logger = sharedAppLogger();
  logger.error(`sidecar 启动失败：${(error as Error)?.stack ?? String(error)}`, undefined, 'boot');
  if (process.env.ATB_CONSOLE === '1') console.error(error);
  process.exit(1);
});
