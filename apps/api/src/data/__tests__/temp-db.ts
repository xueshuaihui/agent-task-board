import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { vi } from 'vitest';
import type { Prisma } from '@prisma/client';
import { newId } from '../../contract/ids';
import { nowSql } from '../../contract/time';
import { paths } from '../../common/paths';
import { applyMigrations } from '../../infra/bootstrap';
import { AuditService } from '../../infra/audit.service';
import type { AppLogger } from '../../infra/logger';
import { PrismaService } from '../../infra/prisma.service';
import { SettingsService } from '../../infra/settings.service';
import { BackupService } from '../../backup/backup.service';
import { DataService } from '../data.service';
import { ImportService } from '../import.service';
import { exportRequestSchema, importRequestSchema, type ExportRequest, type ImportRequest } from '../data.dto';

/**
 * 6.12 的两条通道共用一个临时库：导出侧写出的包，导入侧要能原样吃回去。
 * 每个测试文件一个独立 mkdtemp 目录（照 `agent/__tests__/temp-db.ts` 的写法），
 * 建表走 prisma/migrations 的权威 DDL——`id_sequences` 与 CHECK 只在那里有。
 */

export interface LoggerStub {
  log: ReturnType<typeof vi.fn>;
  warn: ReturnType<typeof vi.fn>;
  error: ReturnType<typeof vi.fn>;
}

export interface DataHarness {
  dir: string;
  prisma: PrismaService;
  settings: SettingsService;
  audit: AuditService;
  backups: BackupService;
  logger: LoggerStub;
  data: DataService;
  imports: ImportService;
  /** 清库 + 清磁盘目录，让每条用例从干净实例出发。 */
  reset: () => Promise<void>;
  dispose: () => Promise<void>;
}

export function createDataHarness(prefix: string): DataHarness {
  const dir = mkdtempSync(path.join(tmpdir(), prefix));
  process.env.ATB_DATA_DIR = dir;
  applyMigrations();

  const prisma = new PrismaService();
  const settings = new SettingsService(prisma);
  const audit = new AuditService(prisma);
  const logger: LoggerStub = { log: vi.fn(), warn: vi.fn(), error: vi.fn() };
  const backups = new BackupService(prisma, audit, logger as unknown as AppLogger);
  const data = new DataService(prisma, audit);
  const imports = new ImportService(prisma, settings, backups, audit, logger as unknown as AppLogger);

  return {
    dir,
    prisma,
    settings,
    audit,
    backups,
    logger,
    data,
    imports,
    reset: async () => {
      await prisma.artifact.deleteMany();
      await prisma.review.deleteMany();
      await prisma.comment.deleteMany();
      await prisma.taskDependency.deleteMany();
      await prisma.taskRun.deleteMany();
      await prisma.task.deleteMany();
      await prisma.customFieldDef.deleteMany();
      await prisma.taskTemplate.deleteMany();
      await prisma.notification.deleteMany();
      await prisma.apiToken.deleteMany();
      await prisma.auditLog.deleteMany();
      await prisma.$executeRawUnsafe(`UPDATE id_sequences SET next = CASE name WHEN 'task' THEN 1000 ELSE 2000 END`);
      rmSync(paths.artifactsDir(), { force: true, recursive: true });
      rmSync(paths.backupsDir(), { force: true, recursive: true });
      mkdirSync(paths.artifactsDir(), { recursive: true });
      mkdirSync(paths.backupsDir(), { recursive: true });
      logger.log.mockClear();
      logger.warn.mockClear();
    },
    dispose: async () => {
      delete process.env.ATB_DATA_DIR;
      await prisma.$disconnect();
      rmSync(dir, { force: true, recursive: true });
    },
  };
}

/**
 * 造数据用的单调时钟：默认时间戳一律比上一条晚 1 秒。
 * 库里的时间是秒级文本，同一秒内造出来的行没有可比性，导出侧「按 created_at 升序」
 * 的断言就会退化成按插入顺序猜——给它们一个真能排序的时间。
 */
let clock = Date.parse('2026-09-01T00:00:00.000Z');
export function nextStamp(): string {
  clock += 1000;
  return nowSql(new Date(clock));
}

/**
 * 造任务。真实写入走 `nextTaskId()`（会抬 `id_sequences`），显式 id 造数据时
 * 必须把序列同步抬上去，否则导入侧的重新编号会撞主键——那不是被测代码的问题，是造数据的问题。
 */
export async function seedTask(
  prisma: PrismaService,
  id: string,
  overrides: Partial<Prisma.TaskUncheckedCreateInput> = {},
): Promise<string> {
  const { title, status, createdAt, updatedAt, ...rest } = overrides;
  await prisma.task.create({
    data: {
      ...rest,
      id,
      title: title ?? `${id} 标题`,
      status: status ?? 'READY',
      createdAt: createdAt ?? nextStamp(),
      updatedAt: updatedAt ?? nextStamp(),
    },
  });
  const numeric = Number(/^T-(\d+)$/.exec(id)?.[1]);
  if (Number.isFinite(numeric)) {
    await prisma.$executeRawUnsafe(`UPDATE id_sequences SET next = max(next, ?) WHERE name = 'task'`, numeric);
  }
  return id;
}

/** 造 Run：默认 SUCCESS（RUNNING 会撞 `uniq_active_run`，需要时显式传）。 */
export async function seedRun(
  prisma: PrismaService,
  id: string,
  taskId: string,
  overrides: Partial<Prisma.TaskRunUncheckedCreateInput> = {},
): Promise<string> {
  const { runNumber, status, triggerType, startedAt, ...rest } = overrides;
  const numeric = Number(/^R-(\d+)$/.exec(id)?.[1]);
  if (Number.isFinite(numeric)) {
    await prisma.$executeRawUnsafe(`UPDATE id_sequences SET next = max(next, ?) WHERE name = 'run'`, numeric);
  }
  await prisma.taskRun.create({
    data: {
      ...rest,
      id,
      taskId,
      runNumber: runNumber ?? 1,
      status: status ?? 'SUCCESS',
      triggerType: triggerType ?? 'agent_poll',
      startedAt: startedAt ?? nextStamp(),
    },
  });
  return id;
}

/** 造产物行（导出不带它的字节，只留一个缺失标记）。 */
export async function seedArtifact(
  prisma: PrismaService,
  taskId: string,
  runId: string,
  uri = `artifacts/${taskId}/${runId}/${newId()}.diff`,
): Promise<string> {
  const id = newId();
  await prisma.artifact.create({
    data: { id, taskId, runId, type: 'diff', uri, sizeBytes: 42, mimeType: 'text/x-diff' },
  });
  return id;
}

export async function seedAudit(prisma: PrismaService, action: string, after: unknown): Promise<void> {
  await prisma.auditLog.create({
    data: { actorType: 'user', actorName: '我', action, targetType: 'task', targetId: 'T-1', after: JSON.stringify(after) },
  });
}

/** 导出入参走一遍 controller 用的同一个 schema，顺带把默认值补齐（`priority` 之类在 wire 上是字符串）。 */
export function exportRequest(req: unknown): ExportRequest {
  return exportRequestSchema.parse(req);
}

/** 导入的 multipart 文本字段同样过 controller 用的 schema（`dry_run` 两种写法都吃）。 */
export function importRequest(req: unknown): ImportRequest {
  return importRequestSchema.parse(req);
}

/** 导入的 multipart 形状：服务侧只看 `buffer` 与 `originalname`。 */
export function importFile(document: unknown): { buffer: Buffer; originalname: string } {
  return {
    buffer: Buffer.isBuffer(document) ? document : Buffer.from(JSON.stringify(document), 'utf8'),
    originalname: 'atb-export.json',
  };
}
