import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { ArgumentMetadata } from '@nestjs/common';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { applyMigrations } from '../../infra/bootstrap';
import { EventsService } from '../../infra/events.service';
import { NotificationsService } from '../../infra/notifications.service';
import { PrismaService } from '../../infra/prisma.service';
import { ZodPipe } from '../../infra/zod.pipe';
import { NotificationsApiController } from '../notifications-api.controller';
import { markReadBodySchema } from '../notifications.dto';

/**
 * 6.7 / 13 章通知接口：读写都在 `infra/notifications.service.ts`，
 * 本测试钉住 controller 暴露出来的响应形状 `{items[], unread_count}` 与 `{ids:[]}|{all:true}` 两种入参。
 */
let dir: string;
let prisma: PrismaService;
let notifications: NotificationsService;

beforeAll(() => {
  dir = mkdtempSync(path.join(tmpdir(), 'atb-notif-'));
  process.env.ATB_DATA_DIR = dir;
  applyMigrations();
  prisma = new PrismaService();
  notifications = new NotificationsService(prisma, new EventsService());
});

afterAll(async () => {
  delete process.env.ATB_DATA_DIR;
  await prisma.$disconnect();
  rmSync(dir, { force: true, recursive: true });
});

async function seedPending(): Promise<void> {
  await prisma.notification.deleteMany();
  await notifications.push('review_pending', null, 'T-1015 待审核');
  await notifications.push('run_failed', null, 'T-1016 执行失败');
  await notifications.push('lease_expired', null, 'T-1017 租约超时');
}

describe('GET /notifications', () => {
  it('默认给全部，unread_count 只数未读（角标的数字来源）', async () => {
    await seedPending();
    await notifications.markRead(null, true);
    await notifications.push('task_unblocked', null, 'T-1018 解除阻塞');

    const all = await notifications.list(false);
    expect(all.items).toHaveLength(4);
    expect(all.unread_count).toBe(1);
    expect(Object.keys(all).sort().join(',')).toBe('items,unread_count');
  });

  it('?unread=true 时 items 只剩未读，时间不倒序，且带任务跳转要用的 task_id', async () => {
    await seedPending();
    const { items } = await notifications.list(true);
    // 同秒插入的三条只保证 `created_at DESC`：infra 的 list 没带 id 兜底，
    // 同秒内的相对次序不做断言（面板阶段二补 UI 时再加）。
    expect(items.map((item) => item.kind).sort()).toEqual(
      ['lease_expired', 'review_pending', 'run_failed'],
    );
    const times = items.map((item) => item.created_at);
    expect([...times].sort().reverse()).toEqual(times);
    expect(items[0]).toMatchObject({ task_id: null });
    expect(items[0].created_at).toMatch(/Z$/);
    expect(items.every((item) => item.read_at === null)).toBe(true);
  });

  it('没有未读时 unread_count 为 0，不是 undefined', async () => {
    await seedPending();
    await notifications.markRead(null, true);
    expect((await notifications.list(true)).items).toEqual([]);
    expect((await notifications.list(false)).unread_count).toBe(0);
  });
});

describe('POST /notifications/read', () => {
  it('{ids:[]} 只标指定几条，其余仍计入未读', async () => {
    await seedPending();
    const { items } = await notifications.list(true);
    const updated = await notifications.markRead([items[0].id], false);
    expect(updated).toEqual({ updated: 1 });
    expect((await notifications.list(true)).unread_count).toBe(2);
  });

  it('{all:true} 清空未读，且重复调用不再更新任何行', async () => {
    await seedPending();
    expect(await notifications.markRead(null, true)).toEqual({ updated: 3 });
    expect(await notifications.markRead(null, true)).toEqual({ updated: 0 });
    expect((await notifications.list(false)).unread_count).toBe(0);
  });

  it('已读行不删除，面板（阶段二）还要读得到', async () => {
    await seedPending();
    await notifications.markRead(null, true);
    expect(await prisma.notification.count()).toBe(3);
  });

  const bodyMeta: ArgumentMetadata = { type: 'body', metatype: Object, data: undefined };
  /** 走真实入参管线：id 长度这类约束只有 pipe 之后才暴露。控制器延迟到用例里建，`notifications` 那时才就绪。 */
  const readThrough = async (body: unknown) =>
    new NotificationsApiController(notifications).markRead(
      await new ZodPipe(markReadBodySchema).transform(body, bodyMeta),
    );

  it('36 位 UUID 的真实 id 能标已读（contract 的 idLike ≤24 会把这条整段拒掉）', async () => {
    await seedPending();
    const { items } = await notifications.list(true);
    expect(items[0].id).toHaveLength(36);
    await expect(readThrough({ ids: [items[0].id] })).resolves.toEqual({ updated: 1 });
    expect((await notifications.list(true)).unread_count).toBe(2);
  });

  it('两种条件都不给 → 422，ids 超 500 条也拒', async () => {
    await expect(readThrough({})).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
    await expect(readThrough({ ids: [], all: false })).rejects.toMatchObject({
      code: 'VALIDATION_FAILED',
    });
    await expect(
      readThrough({ ids: new Array(501).fill('01931a2b-7c8d-7000-8000-000000000001') }),
    ).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
  });
});
