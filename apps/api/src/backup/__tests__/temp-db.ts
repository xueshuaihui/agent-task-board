import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { vi } from 'vitest';
import { newId } from '../../contract/ids';
import { nowSql } from '../../contract/time';
import { paths } from '../../common/paths';
import { applyMigrations } from '../../infra/bootstrap';
import { AuditService } from '../../infra/audit.service';
import type { AppLogger } from '../../infra/logger';
import { PrismaService } from '../../infra/prisma.service';
import { BackupService } from '../backup.service';

/**
 * 9.3 备份/恢复要同时动库文件与磁盘目录，所以这里既建临时库也建临时目录。
 * 建表照 `prisma/migrations` 的权威 DDL（与 `data/__tests__/temp-db.ts` 同一套写法）。
 */

export interface BackupHarness {
  dir: string;
  prisma: PrismaService;
  audit: AuditService;
  backups: BackupService;
  logger: { log: ReturnType<typeof vi.fn>; warn: ReturnType<typeof vi.fn>; error: ReturnType<typeof vi.fn> };
  reset: () => Promise<void>;
  dispose: () => Promise<void>;
}

export function createBackupHarness(prefix: string): BackupHarness {
  const dir = mkdtempSync(path.join(tmpdir(), prefix));
  process.env.ATB_DATA_DIR = dir;
  applyMigrations();

  const prisma = new PrismaService();
  const audit = new AuditService(prisma);
  const logger = { log: vi.fn(), warn: vi.fn(), error: vi.fn() };
  const backups = new BackupService(prisma, audit, logger as unknown as AppLogger);

  return {
    dir,
    prisma,
    audit,
    backups,
    logger,
    reset: async () => {
      await prisma.artifact.deleteMany();
      await prisma.review.deleteMany();
      await prisma.comment.deleteMany();
      await prisma.taskDependency.deleteMany();
      await prisma.taskRun.deleteMany();
      await prisma.task.deleteMany();
      await prisma.auditLog.deleteMany();
      rmSync(paths.artifactsDir(), { force: true, recursive: true });
      rmSync(paths.backupsDir(), { force: true, recursive: true });
      mkdirSync(paths.artifactsDir(), { recursive: true });
      mkdirSync(paths.backupsDir(), { recursive: true });
      logger.log.mockClear();
      logger.warn.mockClear();
      logger.error.mockClear();
    },
    dispose: async () => {
      delete process.env.ATB_DATA_DIR;
      await prisma.$disconnect();
      rmSync(dir, { force: true, recursive: true });
    },
  };
}

/**
 * 一份「可被恢复识别」的最小实例：任务 + Run + 审核 + 产物行 + 产物文件 + 审计。
 * `tag` 会写进标题与产物字节，恢复后靠它判断到底吃进来了哪一份快照。
 */
export async function seedSnapshot(prisma: PrismaService, tag: string): Promise<void> {
  const taskId = `T-${tag}`;
  const runId = `R-${tag}`;
  await prisma.task.create({
    data: {
      id: taskId,
      title: `任务 ${tag}`,
      status: 'REVIEW',
      type: '需求',
      priority: 1,
      createdAt: nowSql(),
      updatedAt: nowSql(),
    },
  });
  await prisma.taskRun.create({
    data: {
      id: runId,
      taskId,
      runNumber: 1,
      status: 'SUCCESS',
      triggerType: 'agent_poll',
      startedAt: nowSql(),
      finishedAt: nowSql(),
      durationMs: 1200,
      summary: `Run ${tag}`,
    },
  });
  await prisma.review.create({
    data: {
      id: `rev-${tag}`,
      taskId,
      runId,
      conclusion: 'APPROVE',
      suggestion: `审核 ${tag}`,
      reason: '',
      detail: '',
      createdAt: nowSql(),
    },
  });
  await prisma.auditLog.create({
    data: {
      actorType: 'user',
      actorName: '我',
      action: 'task_update',
      targetType: 'task',
      targetId: taskId,
      after: JSON.stringify({ tag }),
    },
  });
}

/** 真写一个产物文件，返回 uri（写进 artifacts 行）与磁盘绝对路径。 */
export function seedArtifactFile(taskId: string, runId: string, body: string): { uri: string; file: string } {
  const uri = `artifacts/${taskId}/${runId}/${newId()}.txt`;
  const file = path.resolve(paths.dataDir(), uri);
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, body, 'utf8');
  return { uri, file };
}

export async function seedArtifactRow(
  prisma: PrismaService,
  taskId: string,
  runId: string,
  uri: string,
): Promise<string> {
  const id = newId();
  await prisma.artifact.create({
    data: { id, taskId, runId, type: 'file', uri, sizeBytes: 10, mimeType: 'text/plain' },
  });
  return id;
}

/** 把任务与它当前的 Run 都置为执行中（含租约），恢复后这一对必须变成 FAILED / ABANDONED。 */
export async function seedRunning(prisma: PrismaService, taskId: string, runId: string): Promise<void> {
  // run_number 必须跟着该任务已有的 Run 走：`uniq task_id,run_number` 会撞上前一轮。
  const previous = await prisma.taskRun.count({ where: { taskId } });
  await prisma.taskRun.create({
    data: {
      id: runId,
      taskId,
      runNumber: previous + 1,
      status: 'RUNNING',
      triggerType: 'agent_poll',
      startedAt: nowSql(),
      progress: 55,
      leaseId: `lease-${runId}`,
    },
  });
  await prisma.task.update({
    where: { id: taskId },
    data: {
      status: 'RUNNING',
      leaseId: `lease-${runId}`,
      leaseExpiresAt: nowSql(new Date(Date.now() + 300_000)),
      claimedAt: nowSql(),
      currentRunId: runId,
    },
  });
}

/** 磁盘上放一个非法/垃圾文件，用于验证列表只认形状。字节体会原样落盘（拷真备份用）。 */
export function writeJunk(file: string, body: string | Uint8Array = 'junk'): void {
  mkdirSync(path.dirname(file), { recursive: true });
  if (typeof body === 'string') writeFileSync(file, body, 'utf8');
  else writeFileSync(file, body);
}
