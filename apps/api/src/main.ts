import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { AppModule } from './app.module';
import { corsOptions } from './common/cors';
import { dataDir, port } from './common/paths';
import { resolveUiToken } from './common/ui-token';
import { appVersion } from './common/version';
import { ApiExceptionFilter } from './infra/api-exception.filter';
import { applyMigrations } from './infra/bootstrap';
import { migrateLegacyDataDir } from './infra/data-dir-migration';
import { sharedAppLogger } from './infra/logger';
import { PrismaService } from './infra/prisma.service';
import { queryParser } from './infra/query-parser';
import { SettingsService } from './infra/settings.service';
import { ensureDefaultSkills } from './skills/default-skills';

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
  // §21.1/§21.2：v0.0.3 旧数据目录（~/.agent-board）的一次性搬迁，先于建库跑；
  // 失败即回滚（旧目录原样可启动旧版）并抛出——不带病建空库。
  const dirMove = migrateLegacyDataDir(logger);
  if (!dirMove.migrated && dirMove.reason) logger.log(`数据目录搬迁检查：${dirMove.reason}`, 'boot');
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
  // `custom_fields[key]=v`）就不再解析成对象了，所以这里仍要 extended 语义。
  // D-1：extended 走的是 qs 默认配置，而 qs 默认 `arrayLimit=20`——第 21 个同名多值参数
  // 会退化成数字键对象，`stringListSchema` 认不出数组、422 invalid_union（curl/Agent 面
  // 的 `?requirements[]=…` ×21 与 web `buildQuery` 发的重复键 `?requirements=…` ×21 同一条边界）。
  // 换成显式 parser：保留 extended 的解析行为，只把 arrayLimit 抬到 1000。
  // parser 本体在 `infra/query-parser.ts`，测试底座 `helpers/http-app.ts` 引用同一份，
  // 两处不各写一遍字面量就不会漂移。
  app.set('query parser', queryParser);
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

  // §20.5-15 / 验收 49：默认技能首次启动按 id upsert 预置（只读、随包更新）。
  // 幂等且非致命——预置失败不应阻断看板启动，记 error 后继续（下次启动会重放）。
  try {
    const seeded = await ensureDefaultSkills(app.get(PrismaService));
    if (seeded.created.length + seeded.updated.length > 0) {
      logger.log(
        `默认技能预置：新增 ${seeded.created.length}、更新 ${seeded.updated.length}`,
        'boot',
      );
    }
  } catch (error) {
    logger.error(`默认技能预置失败：${(error as Error)?.stack ?? String(error)}`, undefined, 'boot');
  }

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
