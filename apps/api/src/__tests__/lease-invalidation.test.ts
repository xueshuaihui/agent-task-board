import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { USER_COPY } from '../contract/errors';
import { createTestApp, errorCode, errorMessage, type TestApp } from './helpers/http-app';
import {
  API,
  claimOk,
  newTask,
  shiftLeaseExpiry,
  taskIn,
  toReady,
  triple,
  uiSender,
} from './helpers/seed';

/**
 * 4.3.2 的失效四分支：过期 / 吊销 / 任务已删 / 孤儿回写。
 *
 * 时间差不用真实定时器：租约写入与判定都走 SQLite 的 `datetime('now')`，把
 * `lease_expires_at` 直接挪到过去即可（30 秒的后台扫描在底座里已停掉，回收改为手动调
 * `reclaimExpired()`，否则「已过期但尚未回收」这条分支的判定时机是随机的）。
 *
 * 四条分支的共同底线：**结果不写入**。写没写用 Run 的字段与任务状态判定，不看响应文案。
 */
let t: TestApp;
let ui: ReturnType<typeof uiSender>;

beforeAll(async () => {
  t = await createTestApp();
  ui = uiSender(t);
}, 60_000);

afterAll(async () => {
  await t?.close();
});

describe('租约过期（410 LEASE_EXPIRED）', () => {
  it('过期后 complete 回 410、结果零写入，并在同一判定里完成回收', async () => {
    const fixture = await taskIn(t, 'RUNNING', '过期未续租');
    const { id, key } = fixture;
    await shiftLeaseExpiry(t, id, '-1 minutes');

    const notificationsBefore = await t.prisma.notification.count({ where: { kind: 'review_pending' } });
    const res = await fixture.agent.claims.post(`${API}/tasks/${id}/complete`, {
      ...key!,
      summary: '这条结论不该落库',
      artifacts: [],
    });
    expect(res.status).toBe(410);
    expect(errorCode(res)).toBe('LEASE_EXPIRED');
    expect(errorMessage(res)).toBe(USER_COPY.leaseExpired);
    expect(res.body.error).toMatchObject({ task_id: id, run_id: key!.run_id });

    // 表第 3 行：过期但还没被扫描到时，判定内部先回收再回 410，不留「过期仍可完成」的窗口。
    const stored = await t.prisma.task.findUniqueOrThrow({ where: { id } });
    expect(stored.status).toBe('FAILED');
    expect(stored.stopReason).toBe('lease_expired');
    expect(stored.leaseId).toBeNull();
    expect(stored.leaseExpiresAt).toBeNull();
    expect(stored.currentRunId).toBeNull();

    const run = await t.prisma.taskRun.findUniqueOrThrow({ where: { id: key!.run_id } });
    expect(run.status).toBe('FAILED');
    expect(run.summary).toBeNull();
    expect(run.error).toBe('lease expired');
    expect(run.finishedAt).not.toBeNull();
    expect(await t.prisma.artifact.count({ where: { runId: run.id } })).toBe(0);
    expect(
      await t.prisma.notification.count({ where: { kind: 'review_pending' } }),
    ).toBe(notificationsBefore);

    // 回收留痕：系统状态变更评论 + 审计。
    const comments = await ui.get(`${API}/tasks/${id}/comments`);
    expect(
      comments.body.items.some((item: { content: string }) => item.content.includes('租约超时')),
    ).toBe(true);
    expect(
      await t.prisma.auditLog.count({ where: { action: 'lease_expire', targetId: id } }),
    ).toBe(1);
  });

  it('过期后心跳与进度也一律 410，且不会把到期时刻偷偷推回去', async () => {
    const fixture = await taskIn(t, 'RUNNING', '过期还想续命');
    const { id, key } = fixture;
    const expiredAt = await shiftLeaseExpiry(t, id, '-2 minutes');

    for (const [path, body] of [
      ['heartbeat', { ...key! }],
      ['progress', { ...key!, progress: 50 }],
      ['logs', { ...key!, lines: ['还在跑'] }],
      ['fail', { ...key!, error: '过期后上报失败' }],
    ] as const) {
      const res = await fixture.agent.claims.post(`${API}/tasks/${id}/${path}`, body);
      expect(res.status, path).toBe(410);
      expect(errorCode(res), path).toBe('LEASE_EXPIRED');
    }
    const stored = await t.prisma.task.findUniqueOrThrow({ where: { id } });
    expect(stored.status).toBe('FAILED');
    // fail 的 410 之后没有任何一条路径改动过租约字段。
    expect(stored.leaseExpiresAt).toBeNull();
    expect(stored.leaseId).toBeNull();
    const logs = await t.prisma.comment.count({ where: { runId: key!.run_id, type: 'log' } });
    expect(logs).toBe(0);
    expect((await t.prisma.taskRun.findUniqueOrThrow({ where: { id: key!.run_id } })).error).toBe(
      'lease expired',
    );
    expect(expiredAt).toBeTruthy();
  });

  it('后台扫描的同一具身体：reclaimExpired 一次收干净，再扫无重复副作用', async () => {
    const first = await taskIn(t, 'RUNNING', '扫描回收一');
    const second = await taskIn(t, 'RUNNING', '扫描回收二');
    await shiftLeaseExpiry(t, first.id, '-1 minutes');
    await shiftLeaseExpiry(t, second.id, '-30 seconds');

    const reclaimed = await t.leases.reclaimExpired();
    expect(new Set(reclaimed)).toEqual(new Set([first.id, second.id]));
    for (const fixture of [first, second]) {
      expect(await (await ui.get(`${API}/tasks/${fixture.id}`)).body.status).toBe('FAILED');
    }
    // 幂等：状态已非 RUNNING 的任务不再出现在扫描结果里，也不会二次写审计。
    expect(await t.leases.reclaimExpired()).toEqual([]);
    for (const fixture of [first, second]) {
      expect(
        await t.prisma.auditLog.count({ where: { action: 'lease_expire', targetId: fixture.id } }),
      ).toBe(1);
    }
  });

  it('过期回收后重新认领的新租约可正常回写，旧三元组仍然作废', async () => {
    const fixture = await taskIn(t, 'RUNNING', '过期后重跑');
    const old = { ...fixture.key! };
    await shiftLeaseExpiry(t, fixture.id, '-1 minutes');
    expect((await t.leases.reclaimExpired()).length).toBeGreaterThan(0);

    await ui.post(`${API}/tasks/${fixture.id}/transition`, { to: 'READY' });
    const again = await claimOk(fixture.agent, fixture.id);
    expect(again.lease_id).not.toBe(old.lease_id);

    const stale = await fixture.agent.claims.post(`${API}/tasks/${fixture.id}/progress`, {
      ...old,
      progress: 99,
    });
    expect(stale.status).toBe(410);
    expect(errorCode(stale)).toBe('LEASE_EXPIRED');

    const fresh = await fixture.agent.claims.post(`${API}/tasks/${fixture.id}/progress`, {
      ...triple(again),
      progress: 99,
    });
    expect(fresh.status).toBe(200);
    expect((await t.prisma.taskRun.findUniqueOrThrow({ where: { id: again.run_id } })).progress).toBe(
      99,
    );
  });
});

describe('强制停止吊销（410 LEASE_REVOKED）', () => {
  it('停止后 Agent 的任何回写都是 410 LEASE_REVOKED，结果与状态都不动', async () => {
    const fixture = await taskIn(t, 'RUNNING', '被强制停止');
    const { id, key } = fixture;

    const stopped = await ui.post(`${API}/tasks/${id}/stop`, { reason: '跑偏了' });
    expect(stopped.status).toBe(201);
    expect(stopped.body.status).toBe('FAILED');

    for (const [path, body] of [
      ['heartbeat', { ...key! }],
      ['progress', { ...key!, progress: 70 }],
      ['logs', { ...key!, lines: ['被停止后还在写'] }],
      ['complete', { ...key!, summary: '被停止后交结果', artifacts: [] }],
      ['fail', { ...key!, error: '被停止后报失败' }],
    ] as const) {
      const res = await fixture.agent.claims.post(`${API}/tasks/${id}/${path}`, body);
      expect(res.status, path).toBe(410);
      expect(errorCode(res), path).toBe('LEASE_REVOKED');
      expect(errorMessage(res), path).toBe(USER_COPY.leaseRevoked);
    }

    const stored = await t.prisma.task.findUniqueOrThrow({ where: { id } });
    // 4.3.1 规则 2：停止只吊销租约，任务状态与 stop_reason 保持强制停止时写入的值。
    expect(stored.status).toBe('FAILED');
    expect(stored.stopReason).toBe('user_stop');
    expect(stored.leaseRevokedAt).not.toBeNull();
    const run = await t.prisma.taskRun.findUniqueOrThrow({ where: { id: key!.run_id } });
    expect(run.status).toBe('FAILED');
    expect(run.summary).toBeNull();
    expect(run.progress).toBeNull();
    expect(run.error).toContain('用户强制停止：跑偏了');
    expect(await t.prisma.comment.count({ where: { runId: run.id, type: 'log' } })).toBe(0);
    expect(await t.prisma.artifact.count({ where: { runId: run.id } })).toBe(0);
  });

  it('吊销标记不阻断下一次认领：退回待执行、重新认领后回写恢复正常', async () => {
    const fixture = await taskIn(t, 'RUNNING', '停止后重开');
    await ui.post(`${API}/tasks/${fixture.id}/stop`, {});
    await toReady(t, fixture.id);

    const again = await claimOk(fixture.agent, fixture.id);
    const stored = await t.prisma.task.findUniqueOrThrow({ where: { id: fixture.id } });
    // CLAIM_UPDATE_SQL 清 lease_revoked_at，否则新 Agent 会被吊销分支永久挡在门外。
    expect(stored.leaseRevokedAt).toBeNull();

    const progress = await fixture.agent.claims.post(
      `${API}/tasks/${fixture.id}/progress`,
      { ...triple(again), progress: 10 },
    );
    expect(progress.status).toBe(200);
    const done = await fixture.agent.claims.post(`${API}/tasks/${fixture.id}/complete`, {
      ...triple(again),
      summary: '第二轮结论',
      artifacts: [],
    });
    expect(done.status).toBe(200);
    expect(done.body).toMatchObject({ task_status: 'REVIEW', idempotent: false });
    // 旧三元组（吊销那一轮的 Run）依旧换不回写入权。
    expect(
      (
        await fixture.agent.claims.post(`${API}/tasks/${fixture.id}/heartbeat`, {
          ...fixture.key!,
        })
      ).status,
    ).toBe(410);
  });
});

describe('任务被删除（409 TASK_GONE）', () => {
  it('删除后拿旧三元组回写：409 TASK_GONE，Run 已随任务级联消失', async () => {
    const fixture = await taskIn(t, 'RUNNING', '执行中被删');
    await ui.post(`${API}/tasks/${fixture.id}/stop`, {});
    const deleted = await ui.del(`${API}/tasks/${fixture.id}`);
    expect(deleted.status).toBe(200);
    expect(deleted.body.deleted_runs).toBe(1);

    const res = await fixture.agent.claims.post(`${API}/tasks/${fixture.id}/heartbeat`, {
      ...fixture.key!,
    });
    expect(res.status).toBe(409);
    expect(errorCode(res)).toBe('TASK_GONE');
    expect(errorMessage(res)).toBe('任务已删除，结果未写入');
    expect(res.body.error).toMatchObject({ task_id: fixture.id, run_id: fixture.key!.run_id });
    expect(await t.prisma.taskRun.count({ where: { id: fixture.key!.run_id } })).toBe(0);
  });

  it('run_id 属于别的任务 / 根本不存在的 run_id：410 LEASE_EXPIRED，不暴露任务存在性', async () => {
    const mine = await taskIn(t, 'RUNNING', '张冠李戴');
    const other = await taskIn(t, 'RUNNING', '别人的任务');

    const crossed = await mine.agent.claims.post(`${API}/tasks/${mine.id}/progress`, {
      task_id: mine.id,
      run_id: other.key!.run_id,
      lease_id: mine.key!.lease_id,
      progress: 5,
    });
    expect(crossed.status).toBe(410);
    expect(errorCode(crossed)).toBe('LEASE_EXPIRED');
    expect(errorMessage(crossed)).toContain('run_id 不属于该任务');

    const invented = await mine.agent.claims.post(`${API}/tasks/${mine.id}/heartbeat`, {
      task_id: mine.id,
      run_id: 'R-99999999',
      lease_id: mine.key!.lease_id,
    });
    expect(invented.status).toBe(410);
    expect(errorCode(invented)).toBe('LEASE_EXPIRED');
    // 两次拒绝都不动别人的租约。
    expect((await t.prisma.task.findUniqueOrThrow({ where: { id: other.id } })).status).toBe(
      'RUNNING',
    );
  });
});

describe('孤儿回写（Run 置 ABANDONED）', () => {
  it('租约有效但任务已不在执行中：200、Run ABANDONED、任务状态不回滚', async () => {
    const fixture = await taskIn(t, 'RUNNING', '孤儿回写');
    const { id, key } = fixture;
    // HTTP 侧造不出这个组合（人在任务 RUNNING 时拖不动也删不掉），只能倒改状态，
    // 与 writeback.test.ts 的 moveByHand 同一手法。
    await t.prisma.$executeRawUnsafe(`UPDATE tasks SET status = 'BACKLOG' WHERE id = ?`, id);

    const res = await fixture.agent.claims.post(`${API}/tasks/${id}/complete`, {
      ...key!,
      summary: '任务被人挪走了，我仍然交结果',
      artifacts: [{ type: 'link', uri: 'https://example.com/orphan', name: '孤儿外链' }],
    });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      run_id: key!.run_id,
      run_status: 'ABANDONED',
      task_status: 'BACKLOG',
      orphaned: true,
      idempotent: false,
    });

    const stored = await t.prisma.task.findUniqueOrThrow({ where: { id } });
    // 人的操作优先：任务停在倒改后的状态，不被回写成待审核。
    expect(stored.status).toBe('BACKLOG');
    const run = await t.prisma.taskRun.findUniqueOrThrow({ where: { id: key!.run_id } });
    expect(run.status).toBe('ABANDONED');
    expect(run.summary).toBe('任务被人挪走了，我仍然交结果');
    expect(run.error).toContain('回写时任务已不在执行中');
    expect(run.finishedAt).not.toBeNull();
    expect(await t.prisma.artifact.count({ where: { runId: run.id } })).toBe(1);
    expect(
      await t.prisma.auditLog.count({ where: { action: 'run_writeback', targetId: run.id } }),
    ).toBe(1);
  });

  it('孤儿回写不产生待审核通知，也不留「进入待审核」的系统评论', async () => {
    const fixture = await taskIn(t, 'RUNNING', '孤儿不通知');
    const { id, key } = fixture;
    const notificationsBefore = await t.prisma.notification.count({
      where: { kind: 'review_pending' },
    });
    await t.prisma.$executeRawUnsafe(`UPDATE tasks SET status = 'READY' WHERE id = ?`, id);

    const progress = await fixture.agent.claims.post(`${API}/tasks/${id}/progress`, {
      ...key!,
      progress: 30,
    });
    expect(progress.status).toBe(200);
    expect(progress.body.orphaned).toBe(true);

    const logs = await fixture.agent.claims.post(`${API}/tasks/${id}/logs`, {
      ...key!,
      lines: ['孤儿日志一行'],
    });
    expect(logs.status).toBe(200);
    expect(logs.body.orphaned).toBe(true);

    const done = await fixture.agent.claims.post(`${API}/tasks/${id}/complete`, {
      ...key!,
      summary: '孤儿的结论',
      artifacts: [],
    });
    expect(done.status).toBe(200);
    expect(done.body).toMatchObject({ orphaned: true, task_status: 'READY', run_status: 'ABANDONED' });

    expect(
      await t.prisma.notification.count({ where: { kind: 'review_pending' } }),
    ).toBe(notificationsBefore);
    const comments = await ui.get(`${API}/tasks/${id}/comments`);
    expect(
      comments.body.items.some((item: { content: string }) => item.content.includes('进入待审核')),
    ).toBe(false);
    // ABANDONED 不能被回写成 SUCCESS：整条孤儿链路上 Run 状态只前进一次。
    expect((await t.prisma.taskRun.findUniqueOrThrow({ where: { id: key!.run_id } })).status).toBe(
      'ABANDONED',
    );
  });
});
