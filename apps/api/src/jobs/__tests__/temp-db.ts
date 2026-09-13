import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { applyMigrations } from '../../infra/bootstrap';
import { PrismaService } from '../../infra/prisma.service';
import { nowSql } from '../../contract/time';

/**
 * 独立临时库：ATB_DATA_DIR 指到 mkdtemp 目录后，PrismaService 的连接串就落在
 * 该目录的 atb.db 上，绝不碰 apps/api/prisma/dev.db（并行 agent 共用同一个工作区）。
 * 建表直接跑 prisma/migrations 的权威 DDL，比 `prisma db push` 快一个量级。
 */
export interface TempDb {
  dir: string;
  prisma: PrismaService;
  dispose: () => Promise<void>;
}

export function createTempDb(prefix: string): TempDb {
  const dir = mkdtempSync(path.join(tmpdir(), prefix));
  process.env.ATB_DATA_DIR = dir;
  applyMigrations();
  const prisma = new PrismaService();
  return {
    dir,
    prisma,
    dispose: async () => {
      await prisma.$disconnect();
      rmSync(dir, { force: true, recursive: true });
    },
  };
}

/** `updated_at` 是文本列，测试要造「N 天前」只能自己算 UTC 文本。 */
export function daysAgo(days: number, from: Date = new Date()): string {
  return nowSql(new Date(from.getTime() - days * 24 * 3600 * 1000));
}
