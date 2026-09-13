import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { claimSchema } from '../agent-inputs';
import { LEASE_SWEEP_INTERVAL_MS } from '../lease.service';
import type { RequestAuth } from '../../auth/auth.scope';
import { backdateLease, createAgentHarness, seedTask, tripleOf, type AgentHarness } from './temp-db';

/**
 * 4.3.2 的后台回收：每 30 秒扫一次 `status='RUNNING' AND lease_expires_at <= now`，
 * 同一事务内把任务与 Run 一起收尾。测点集中在两件事——「收得干净」（不留悬挂租约）
 * 与「不越权」（不碰未过期、不碰已被人改走状态的任务）。
 */
let h: AgentHarness;
let agent: RequestAuth;

const CLAIM = claimSchema.parse({});

beforeAll(async () => {
  h = createAgentHarness();
  agent = await h.agent('sweeper-test');
});

afterAll(async () => {
  await h.dispose();
});

beforeEach(async () => {
  await h.prisma.notification.deleteMany();
  await h.prisma.auditLog.deleteMany();
  await h.prisma.comment.deleteMany();
  await h.prisma.taskRun.deleteMany();
  await h.prisma.task.deleteMany();
  h.emitted.length = 0;
});

describe('reclaimExpired', () => {
  it('扫描周期是 30 秒（4.3.2 固定值）', () => {
    expect(LEASE_SWEEP_INTERVAL_MS).toBe(30_000);
  });

  it('过期任务在同一个事务里收尾：状态、租约字段、Run、审计、事件、通知', async () => {
    await seedTask(h.prisma, 'T-1');
    const key = tripleOf(await h.claims.claim(CLAIM, agent));
    await backdateLease(h.prisma, 'T-1');

    expect(await h.leases.reclaimExpired()).toEqual(['T-1']);

    const task = await h.prisma.task.findUniqueOrThrow({ where: { id: 'T-1' } });
    expect(task.status).toBe('FAILED');
    expect(task.stopReason).toBe('lease_expired');
    expect(task.leaseId).toBeNull();
    expect(task.leaseExpiresAt).toBeNull();
    expect(task.currentRunId).toBeNull();

    const run = await h.prisma.taskRun.findUniqueOrThrow({ where: { id: key.run_id } });
    expect(run.status).toBe('FAILED');
    expect(run.error).toBe('lease expired');
    expect(run.finishedAt).not.toBeNull();
    expect(run.durationMs).toBeTypeOf('number');

    expect(await h.prisma.auditLog.count({ where: { action: 'lease_expire', actorType: 'system' } })).toBe(1);
    expect(await h.prisma.comment.count({ where: { type: 'status_change' } })).toBe(1);
    expect(await h.prisma.notification.count({ where: { kind: 'lease_expired', taskId: 'T-1' } })).toBe(1);
    expect(h.emitted.map((event) => event.event)).toEqual([
      'task.moved',
      'task.updated',
      'lease.expired',
      'task.moved',
      'task.updated',
      'notification.created',
    ]);
    expect(
      h.emitted.filter((event) => event.event === 'lease.expired').map((event) => event.data),
    ).toEqual([{ task_id: 'T-1', run_id: key.run_id }]);
  });

  it('未过期的租约不被回收，重复扫描幂等', async () => {
    await seedTask(h.prisma, 'T-1');
    await h.claims.claim(CLAIM, agent);

    expect(await h.leases.reclaimExpired()).toEqual([]);
    expect((await h.prisma.task.findUniqueOrThrow({ where: { id: 'T-1' } })).status).toBe('RUNNING');

    await backdateLease(h.prisma, 'T-1');
    expect(await h.leases.reclaimExpired()).toEqual(['T-1']);
    expect(await h.leases.reclaimExpired()).toEqual([]);
    expect(await h.prisma.notification.count({ where: { kind: 'lease_expired' } })).toBe(1);
  });

  it('lease_expires_at 为空的 RUNNING 也回收，否则永远卡在异常列之外', async () => {
    await seedTask(h.prisma, 'T-1');
    const key = tripleOf(await h.claims.claim(CLAIM, agent));
    await h.prisma.$executeRawUnsafe(`UPDATE tasks SET lease_expires_at = NULL WHERE id = 'T-1'`);

    expect(await h.leases.reclaimExpired()).toEqual(['T-1']);
    const run = await h.prisma.taskRun.findUniqueOrThrow({ where: { id: key.run_id } });
    expect(run.status).toBe('FAILED');
  });

  it('非 RUNNING 的任务不受扫描影响：强制停止后的状态与 stop_reason 保持原样', async () => {
    await seedTask(h.prisma, 'T-1');
    const key = tripleOf(await h.claims.claim(CLAIM, agent));
    await h.prisma.$executeRawUnsafe(
      `UPDATE tasks SET status='FAILED', stop_reason='user_stop', lease_revoked_at=datetime('now'),
              current_run_id=NULL, lease_expires_at=datetime('now','-1 minutes') WHERE id='T-1'`,
    );

    expect(await h.leases.reclaimExpired()).toEqual([]);
    const task = await h.prisma.task.findUniqueOrThrow({ where: { id: 'T-1' } });
    expect(task.stopReason).toBe('user_stop');
    expect(await h.prisma.taskRun.findUniqueOrThrow({ where: { id: key.run_id } })).toMatchObject({
      status: 'RUNNING',
    });
  });

  it('回收后的任务退回待执行即可被重新认领，且新租约不受旧吊销标记影响', async () => {
    await seedTask(h.prisma, 'T-1');
    const stale = tripleOf(await h.claims.claim(CLAIM, agent));
    await backdateLease(h.prisma, 'T-1');
    await h.leases.reclaimExpired();

    await h.prisma.$executeRawUnsafe(
      `UPDATE tasks SET status='READY', lease_revoked_at=datetime('now') WHERE id='T-1'`,
    );
    const fresh = tripleOf(await h.claims.claim(CLAIM, agent));
    expect(fresh.run_id).not.toBe(stale.run_id);

    // 旧三元组已经彻底作废，新 Agent 的回写必须放行——否则一次吊销就把任务永久锁死。
    await expect(
      h.writeback.updateProgress(
        { ...fresh, progress: 10, message: undefined },
        agent,
      ),
    ).resolves.toMatchObject({ orphaned: false });
    await expect(
      h.writeback.updateProgress({ ...stale, progress: 90 }, agent),
    ).rejects.toMatchObject({ code: 'LEASE_EXPIRED' });
  });
});
