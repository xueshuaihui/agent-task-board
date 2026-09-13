import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { newId } from '../../contract/ids';
import { EventsService, type WsEvent } from '../../infra/events.service';
import { NotificationsService } from '../../infra/notifications.service';
import { PrismaService } from '../../infra/prisma.service';
import { DependencyUnlockService } from '../dependency-unlock.service';
import { NotificationTriggers } from '../notification-triggers.service';
import { createTempDb, type TempDb } from './temp-db';

/**
 * 5.5 的判据必须和 5.4 的认领过滤一致：多前置的任务只有最后一条 `blocks` 转 DONE
 * 的那一刻才算解锁，否则会双发（前端角标闪两下、通知里多出重复条目）。
 */
let db: TempDb;
let prisma: PrismaService;
let unlocker: DependencyUnlockService;
let events: EventsService;
let emitted: WsEvent[];

async function seed(id: string, status: string, archivedAt: string | null = null) {
  await prisma.task.create({ data: { id, title: `${id} 标题`, status, archivedAt } });
}

async function depend(taskId: string, dependsOn: string, type = 'blocks') {
  await prisma.taskDependency.create({
    data: { id: newId(), taskId, dependsOn, type },
  });
}

function unblockedIds(): string[] {
  return emitted
    .filter((event) => event.event === 'task.unblocked')
    .map((event) => String((event.data as { task_id: string }).task_id));
}

beforeAll(() => {
  db = createTempDb('atb-unlock-');
  prisma = db.prisma;
  events = new EventsService();
  emitted = [];
  events.registerSink((event) => emitted.push(event));
  const notifications = new NotificationsService(prisma, events);
  unlocker = new DependencyUnlockService(prisma, events, new NotificationTriggers(prisma, notifications));
});

afterAll(async () => {
  await db.dispose();
});

beforeEach(async () => {
  await prisma.notification.deleteMany();
  await prisma.taskDependency.deleteMany();
  await prisma.task.deleteMany();
  emitted.length = 0;
  unlocker.resetDedupe();
});

describe('scanAndNotify', () => {
  it('多前置时只在最后一条 blocks 满足后发一次 task.unblocked', async () => {
    await seed('T-100', 'DONE');
    await seed('T-101', 'READY');
    await seed('T-102', 'READY');
    await depend('T-102', 'T-100');
    await depend('T-102', 'T-101');

    expect(await unlocker.scanAndNotify('T-100')).toEqual([]);
    expect(unblockedIds()).toEqual([]);

    await prisma.task.update({ where: { id: 'T-101' }, data: { status: 'DONE' } });
    expect(await unlocker.scanAndNotify('T-101')).toEqual(['T-102']);
    expect(unblockedIds()).toEqual(['T-102']);
    expect(
      emitted.filter((event) => event.event === 'notification.created' && event.data['kind'] === 'task_unblocked'),
    ).toHaveLength(1);
  });

  it('同一前置重复扫描不双发（旧 lease 回写重入）', async () => {
    await seed('T-200', 'DONE');
    await seed('T-201', 'READY');
    await depend('T-201', 'T-200');

    await unlocker.scanAndNotify('T-200');
    await unlocker.scanAndNotify('T-200');
    await unlocker.scanAndNotify('T-200');

    expect(unblockedIds()).toEqual(['T-201']);
  });

  it('relates 依赖不算阻塞', async () => {
    await seed('T-300', 'DONE');
    await seed('T-301', 'BACKLOG');
    await seed('T-302', 'READY');
    await depend('T-302', 'T-300');
    await depend('T-302', 'T-301', 'relates');

    expect(await unlocker.scanAndNotify('T-300')).toEqual(['T-302']);
  });

  it('BACKLOG 与已归档的下游不发解锁通知', async () => {
    await seed('T-400', 'DONE');
    await seed('T-401', 'BACKLOG');
    await seed('T-402', 'READY', '2026-01-01 00:00:00');
    await depend('T-401', 'T-400');
    await depend('T-402', 'T-400');

    expect(await unlocker.scanAndNotify('T-400')).toEqual([]);
    expect(unblockedIds()).toEqual([]);
  });

  it('仍有未满足前置时 remainingBlockers 给出剩余数量', async () => {
    await seed('T-500', 'DONE');
    await seed('T-501', 'READY');
    await seed('T-502', 'FAILED');
    await seed('T-503', 'READY');
    await depend('T-503', 'T-500');
    await depend('T-503', 'T-501');
    await depend('T-503', 'T-502');

    expect(await unlocker.remainingBlockers('T-503')).toBe(2);
    expect(await unlocker.scanAndNotify('T-500')).toEqual([]);
  });
});

describe('NotificationTriggers（6.7 三个未落库的触发点）', () => {
  it('进入待审核、执行失败、审核驳回各落一条，并带上服务端算好的 unread_count', async () => {
    await seed('T-600', 'REVIEW');
    const triggers = new NotificationTriggers(prisma, new NotificationsService(prisma, events));

    await triggers.reviewPending('T-600');
    await triggers.runFailed('T-600', { runId: 'R-1', reason: 'exit code 1' });
    await triggers.reviewRejected('T-600', { opinion: '签名校验需覆盖空值' });

    const rows = await prisma.notification.findMany();
    const byKind = new Map(rows.map((row) => [row.kind, row]));
    expect([...byKind.keys()].sort()).toEqual(['review_pending', 'review_rejected', 'run_failed']);
    expect(byKind.get('review_pending')?.message).toBe('T-600 进入待审核 · T-600 标题');
    expect(byKind.get('run_failed')?.message).toBe('T-600 执行失败（R-1）：exit code 1 · T-600 标题');
    expect(byKind.get('review_rejected')?.message).toBe(
      'T-600 审核被驳回：签名校验需覆盖空值 · T-600 标题',
    );
    expect(emitted.filter((event) => event.event === 'notification.created').at(-1)?.data).toMatchObject({
      kind: 'review_rejected',
      task_id: 'T-600',
      unread_count: 3,
    });
  });

  it('同一任务同一 kind 已有未读时不重复插入（6.7 落库规则）', async () => {
    await seed('T-700', 'REVIEW');
    const triggers = new NotificationTriggers(prisma, new NotificationsService(prisma, events));

    await triggers.reviewPending('T-700');
    const again = await triggers.reviewPending('T-700');

    expect(again).toBeNull();
    expect(await prisma.notification.count({ where: { kind: 'review_pending' } })).toBe(1);
  });

  it('任务不存在时按 13 章抛 NOT_FOUND', async () => {
    const triggers = new NotificationTriggers(prisma, new NotificationsService(prisma, events));
    await expect(triggers.reviewPending('T-404')).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });
});
