import { afterAll, beforeEach, beforeAll, describe, expect, it } from 'vitest';
import { newId } from '../../contract/ids';
import { AuditService } from '../../infra/audit.service';
import { EventsService, type WsEvent } from '../../infra/events.service';
import type { AppLogger } from '../../infra/logger';
import { SettingsService } from '../../infra/settings.service';
import { PrismaService } from '../../infra/prisma.service';
import { AutoArchiveJob } from '../auto-archive.job';
import { createTempDb, daysAgo, type TempDb } from './temp-db';

/**
 * 自动归档的核心风险不是「归档没生效」，而是「把仍是前置的 DONE 任务归档掉」
 * ——那会让下游永久阻塞且在看板上不可见（4.3.1 规则 3），所以跳过分歧必须留审计。
 */
const SILENT_LOGGER = {
  log: () => undefined,
  debug: () => undefined,
  warn: () => undefined,
  error: () => undefined,
} as unknown as AppLogger;

let db: TempDb;
let prisma: PrismaService;
let settings: SettingsService;
let job: AutoArchiveJob;
let emitted: WsEvent[];

async function seedTask(id: string, status: string, updatedAt: string, archivedAt: string | null = null) {
  await prisma.task.create({ data: { id, title: `${id} 标题`, status, updatedAt, archivedAt } });
}

async function seedBlock(downstream: string, prerequisite: string, type = 'blocks') {
  await prisma.taskDependency.create({
    data: { id: newId(), taskId: downstream, dependsOn: prerequisite, type },
  });
}

async function seedDoneOlderThanThreshold(id: string): Promise<void> {
  await seedTask(id, 'DONE', daysAgo(60));
}

beforeAll(() => {
  db = createTempDb('atb-auto-archive-');
  prisma = db.prisma;
  settings = new SettingsService(prisma);
  const audit = new AuditService(prisma);
  const events = new EventsService();
  emitted = [];
  events.registerSink((event) => emitted.push(event));
  job = new AutoArchiveJob(prisma, settings, audit, events, SILENT_LOGGER);
});

afterAll(async () => {
  await db.dispose();
});

beforeEach(async () => {
  await prisma.taskDependency.deleteMany();
  await prisma.auditLog.deleteMany();
  await prisma.task.deleteMany();
  emitted.length = 0;
  await settings.patch({ auto_archive_days: 30 });
});

describe('runOnce 候选判定', () => {
  it('只回收 DONE 且 updated_at 超过阈值的未归档任务', async () => {
    await seedDoneOlderThanThreshold('T-100');
    await seedTask('T-103', 'DONE', daysAgo(5));
    await seedTask('T-104', 'REVIEW', daysAgo(60));
    await seedTask('T-105', 'FAILED', daysAgo(60));
    await seedTask('T-106', 'DONE', daysAgo(60), daysAgo(1));

    const outcome = await job.runOnce();

    expect(outcome.scanned).toBe(1);
    expect(outcome.archived).toEqual(['T-100']);
    const archived = await prisma.task.findUnique({ where: { id: 'T-100' } });
    expect(archived?.archivedAt).toMatch(/^\d{4}-\d{2}-\d{2} /);
    expect(outcome.days).toBe(30);
  });

  it('auto_archive_days=0 是关闭开关，不是归档全部（20.9）', async () => {
    await seedDoneOlderThanThreshold('T-100');
    await settings.patch({ auto_archive_days: 0 });

    const outcome = await job.runOnce();

    expect(outcome.archived).toEqual([]);
    expect(outcome.scanned).toBe(0);
    expect(await prisma.task.findUnique({ where: { id: 'T-100' } })).toMatchObject({ archivedAt: null });
  });
});

describe('4.3.1 规则 3：跳过会造成死锁的归档', () => {
  it('仍是未完成任务的 blocks 前置时跳过，并写一条 archive_skipped 审计', async () => {
    await seedDoneOlderThanThreshold('T-100');
    await seedDoneOlderThanThreshold('T-101');
    await seedTask('T-102', 'READY', daysAgo(10));
    await seedBlock('T-102', 'T-101');

    const outcome = await job.runOnce();

    expect(outcome.archived).toEqual(['T-100']);
    expect(outcome.skipped).toEqual([{ id: 'T-101', downstream: ['T-102'] }]);
    expect(await prisma.task.findUnique({ where: { id: 'T-101' } })).toMatchObject({ archivedAt: null });

    const skippedAudit = await prisma.auditLog.findFirst({ where: { action: 'archive_skipped' } });
    expect(skippedAudit).not.toBeNull();
    expect(skippedAudit?.actorType).toBe('system');
    expect(skippedAudit?.targetId).toBe('T-101');
    expect(JSON.parse(String(skippedAudit?.after))).toMatchObject({ downstream: ['T-102'] });
  });

  it('下游已完成或被归档时不再算阻塞，正常回收', async () => {
    await seedDoneOlderThanThreshold('T-200');
    await seedTask('T-201', 'DONE', daysAgo(3));
    await seedBlock('T-201', 'T-200');
    await seedTask('T-202', 'READY', daysAgo(3), daysAgo(1));
    await seedBlock('T-202', 'T-200');

    const outcome = await job.runOnce();

    expect(outcome.archived).toEqual(['T-200']);
    expect(outcome.skipped).toEqual([]);
  });

  it('relates 类型不阻塞归档', async () => {
    await seedDoneOlderThanThreshold('T-300');
    await seedTask('T-301', 'READY', daysAgo(1));
    await seedBlock('T-301', 'T-300', 'relates');

    const outcome = await job.runOnce();

    expect(outcome.archived).toEqual(['T-300']);
  });

  it('跳过的任务不重试，也不发 task.archived 事件', async () => {
    await seedDoneOlderThanThreshold('T-400');
    await seedTask('T-401', 'BACKLOG', daysAgo(1));
    await seedBlock('T-401', 'T-400');

    const first = await job.runOnce();
    const second = await job.runOnce();

    expect(first.skipped.map((row) => row.id)).toEqual(['T-400']);
    expect(second.skipped.map((row) => row.id)).toEqual(['T-400']);
    expect(emitted.filter((event) => event.event === 'task.archived')).toHaveLength(0);
    expect(await prisma.auditLog.count({ where: { action: 'archive_skipped' } })).toBe(2);
  });

  it('归档成功发 task.archived，载荷形状按 13 章只认 task_id', async () => {
    await seedDoneOlderThanThreshold('T-500');

    await job.runOnce();

    expect(emitted).toHaveLength(1);
    // 契约只约束载荷形状（`ts` 由 EventsService 统一盖章），所以逐字段断言而不是整帧 toEqual。
    expect(emitted[0]?.event).toBe('task.archived');
    expect(emitted[0]?.data).toEqual({ task_id: 'T-500', archived: true });
    const audit = await prisma.auditLog.findFirst({ where: { action: 'task_archive' } });
    expect(audit?.actorType).toBe('system');
  });
});
