import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { LEASE_SWEEP_INTERVAL_MS } from '../agent/lease.service';
import { USER_COPY } from '../contract/errors';
import { createTestApp, errorCode, errorMessage, type TestApp } from './helpers/http-app';
import {
  API,
  shiftLeaseExpiry,
  taskIn,
  uiSender,
  type Fixture,
} from './helpers/seed';

/**
 * 验收 13 / 4.3.2 的**装配面**：`lease-sweeper.test.ts` 与 `lease-invalidation.test.ts`
 * 都是直接调 `reclaimExpired()` 来断言回收结果，那只证明「函数会对」，不证明
 * 「应用启动后这个扫描真的会自己动」。定时器没接到 `onModuleInit` 上（或周期被人改没、
 * 或 close 时不停）的话，前面那些用例照样全绿，而生产路径上过期租约永远留在执行中列。
 *
 * 这里跑的是真 `AppModule`（临时数据目录 + 127.0.0.1 随机端口），周期经
 * `ATB_LEASE_SWEEP_OPTIONS` 压到 `SWEEP_MS`；**回收那一步全文件没有一处手工调 sweep**，
 * 任务回到异常列只能由那个定时器促成（停机用例里的手工调用是反面对照，见最后一条）。
 */
const SWEEP_MS = 40;

/** 一次看板响应里各列的卡片 id。 */
async function boardSnapshot(t: TestApp): Promise<Map<string, string[]>> {
  const res = await uiSender(t).get<{ columns: { status: string; tasks: { id: string }[] }[] }>(
    `${API}/board`,
  );
  if (res.status !== 200) throw new Error(`读取看板失败：${res.status} ${res.text}`);
  return new Map(res.body.columns.map((column) => [column.status, column.tasks.map((item) => item.id)]));
}

function columnOf(snapshot: Map<string, string[]>, status: string): string[] {
  return snapshot.get(status) ?? [];
}

/**
 * 等到「同一份响应里已在异常列、且不在执行中列」为止。
 *
 * 注意 vi.waitFor 的语义：回调**抛错**才会重试，返回 false 会被当成成功直接放行。
 * 所以条件不满足时必须 throw，否则这个等待只是「读一次快照」，CI 慢机上定时器
 * 还没来得及回收就直接通过了。
 *
 * 六列与列头计数在 `tasks.board()` 里是各自独立的语句，一次状态变更正好跨过请求边界时，
 * 同一份响应会把同一张卡在执行中列与异常列各摆一次（下一次读就自好了）。
 * 这里轮询的是一次完整快照，而不是分两次读两列——否则等来的可能是那份自相矛盾的中间态。
 */
async function waitForMovedToFailed(t: TestApp, id: string): Promise<void> {
  await vi.waitFor(
    async () => {
      const snapshot = await boardSnapshot(t);
      const moved =
        columnOf(snapshot, 'FAILED').includes(id) && !columnOf(snapshot, 'RUNNING').includes(id);
      if (!moved) {
        throw new Error(`任务 ${id} 尚未由定时器回收进异常列（waitFor 重试中）`);
      }
    },
    // 本地 40ms 周期两跳内就位；CI 慢机（3-4 vCPU 跑 37 个文件并行）给足余量。
    { timeout: 15_000, interval: 25 },
  );
}

describe('生产装配的扫描周期：不注入就是 4.3.2 那个 30 秒', () => {
  it('AppModule 直接启动时 onModuleInit 已把定时器挂上，周期 30_000ms', async () => {
    // 与上一段相反：这里刻意不传任何注入，走 main.ts 的那条装配路径。
    const plain = await createTestApp();
    try {
      expect(plain.bootedSweeper).toEqual({ running: true, intervalMs: LEASE_SWEEP_INTERVAL_MS });
      expect(plain.bootedSweeper.intervalMs).toBe(30_000);
    } finally {
      await plain.close();
    }
  }, 60_000);
});

describe('真实启动的 sidecar：过期租约由定时器自己收回（验收 13）', () => {
  let t: TestApp;
  let fixture: Fixture;

  beforeAll(async () => {
    t = await createTestApp({ leaseSweepIntervalMs: SWEEP_MS });
    fixture = await taskIn(t, 'RUNNING', '租约超时后自己回异常列');
    // 租约时限是分钟级（`lease_ttl_minutes`），这里只把到期时刻挪到过去来跨过那条线；
    // 之后到卡片进异常列为止，没有人续期、也没人调过 reclaimExpired，促成回收的只能是那个定时器。
    await shiftLeaseExpiry(t, fixture.id, '-2 minutes');
    await waitForMovedToFailed(t, fixture.id);
  }, 60_000);

  afterAll(async () => {
    await t?.close();
  });

  it('注入的周期生效，且 onModuleInit 之后没人再动过定时器', () => {
    expect(t.bootedSweeper).toEqual({ running: true, intervalMs: SWEEP_MS });
    expect(t.leases.sweeperRunning).toBe(true);
    expect(t.leases.sweeperIntervalMs).toBe(SWEEP_MS);
  });

  it('无人续期、无人手工扫描：任务自己离开执行中列、落进异常/失败列', async () => {
    // board() 的分列查询不在同一事务里（本文件头部的竞态注释）：CI 慢机上单次快照
    // 可能恰好跨着回收事务的提交边界，读到「仍在执行中列」的中间态。
    // 与 beforeAll 同样轮询到一致态再断言终态——语义不变（终态必须是 FAILED 且不在
    // RUNNING），只是不再把「读的时机」当成被测对象；若真被翻回 RUNNING，这里会
    // 以 15s 超时的形式给出比单次快照更强的失败信号。
    await waitForMovedToFailed(t, fixture.id);
    const snapshot = await boardSnapshot(t);
    expect(columnOf(snapshot, 'RUNNING')).not.toContain(fixture.id);
    expect(columnOf(snapshot, 'FAILED')).toContain(fixture.id);

    const stored = await t.prisma.task.findUniqueOrThrow({ where: { id: fixture.id } });
    expect(stored).toMatchObject({
      status: 'FAILED',
      stopReason: 'lease_expired',
      leaseId: null,
      leaseExpiresAt: null,
      currentRunId: null,
    });
    const run = await t.prisma.taskRun.findUniqueOrThrow({ where: { id: fixture.key!.run_id } });
    expect(run).toMatchObject({ status: 'FAILED', error: 'lease expired', summary: null });
    expect(run.finishedAt).not.toBeNull();
    // 定时器走的是同一条回收链路：留痕（系统评论 + 审计 + 通知）也该齐。
    expect(await t.prisma.auditLog.count({ where: { action: 'lease_expire', targetId: fixture.id } })).toBe(1);
    expect(
      await t.prisma.notification.count({ where: { kind: 'lease_expired', taskId: fixture.id } }),
    ).toBe(1);
  });

  it('超时后再调 complete_task：410 LEASE_EXPIRED，任务仍停在异常列', async () => {
    const res = await fixture.agent.claims.post(`${API}/tasks/${fixture.id}/complete`, {
      ...fixture.key!,
      summary: '超时后才交的结果',
      artifacts: [{ type: 'link', uri: 'https://example.com/too-late', name: '超时的外链' }],
    });
    expect(res.status).toBe(410);
    expect(errorCode(res)).toBe('LEASE_EXPIRED');
    expect(errorMessage(res)).toBe(USER_COPY.leaseExpired);
    expect(res.body.error).toMatchObject({
      task_id: fixture.id,
      run_id: fixture.key!.run_id,
    });

    const after = await boardSnapshot(t);
    expect(columnOf(after, 'FAILED')).toContain(fixture.id);
    expect(columnOf(after, 'REVIEW')).not.toContain(fixture.id);
    expect((await t.prisma.task.findUniqueOrThrow({ where: { id: fixture.id } })).status).toBe('FAILED');
  });

  it('产物不入库：这条 Run 一条产物都没有，也没有待审核通知', async () => {
    expect(await t.prisma.artifact.count({ where: { runId: fixture.key!.run_id } })).toBe(0);
    expect(await t.prisma.artifact.count({ where: { taskId: fixture.id } })).toBe(0);
    expect(
      await t.prisma.notification.count({ where: { kind: 'review_pending', taskId: fixture.id } }),
    ).toBe(0);
    expect(
      await t.prisma.taskRun.count({ where: { id: fixture.key!.run_id, summary: null } }),
    ).toBe(1);
  });

  it('应用 close 之后定时器不再触发：停机后才过期的租约留在执行中列', async () => {
    // 认领时租约还有 30 分钟，所以它在停机前不会被收走；停机后再把它挪到已过期。
    const survivor = await taskIn(t, 'RUNNING', '停机之后才过期');
    await t.closeApp();
    // onModuleDestroy 没接上的话这里仍是 true：热重载与优雅退出都会被那个定时器拖住。
    expect(t.leases.sweeperRunning).toBe(false);

    await shiftLeaseExpiry(t, survivor.id, '-2 minutes');
    await new Promise((resolve) => setTimeout(resolve, SWEEP_MS * 10));
    expect(
      (await t.prisma.task.findUniqueOrThrow({ where: { id: survivor.id } })).status,
    ).toBe('RUNNING');

    // 对照组：同一条租约手工调一次扫描就立刻被收走——上面那句 RUNNING 不是「回收坏了」。
    expect(await t.leases.reclaimExpired()).toEqual([survivor.id]);
    expect((await t.prisma.task.findUniqueOrThrow({ where: { id: survivor.id } })).status).toBe(
      'FAILED',
    );
  }, 30_000);
});
