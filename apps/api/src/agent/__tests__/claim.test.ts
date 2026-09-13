import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { newId } from '../../contract/ids';
import { claimSchema, listReadyQuerySchema } from '../agent-inputs';
import type { RequestAuth } from '../../auth/auth.scope';
import { createAgentHarness, seedTask, tripleOf, type AgentHarness } from './temp-db';

/**
 * 9.3 认领。这块的核心风险是「两个 Agent 抢到同一个任务」和「没抢到却留下了写痕」，
 * 两者都会让租约语义失去意义，所以断言落在数据库行上而不是返回值上。
 */
let h: AgentHarness;
let agentA: RequestAuth;
let agentB: RequestAuth;

const claimInput = claimSchema.parse({});

beforeAll(async () => {
  h = createAgentHarness();
  agentA = await h.agent('agent-a');
  agentB = await h.agent('agent-b');
});

afterAll(async () => {
  await h.dispose();
});

beforeEach(async () => {
  await h.prisma.taskDependency.deleteMany();
  await h.prisma.auditLog.deleteMany();
  await h.prisma.comment.deleteMany();
  await h.prisma.taskRun.deleteMany();
  await h.prisma.task.deleteMany();
  await h.prisma.$executeRawUnsafe(`UPDATE id_sequences SET next = 0 WHERE name = 'run'`);
  h.emitted.length = 0;
});

async function runRow(name: string) {
  return h.prisma.$queryRawUnsafe<{ next: number }[]>(
    `SELECT next FROM id_sequences WHERE name = ?`,
    name,
  );
}

async function taskRow(id: string) {
  const row = await h.prisma.task.findUniqueOrThrow({ where: { id } });
  return row;
}

describe('claim_next_task', () => {
  it('队列只剩 1 个任务时只有一个 Agent 抢到，另一方零写入（验收 11）', async () => {
    await seedTask(h.prisma, 'T-1');

    const [first, second] = await Promise.all([
      h.claims.claim(claimInput, agentA),
      h.claims.claim(claimInput, agentB),
    ]);

    const wins = [first, second].filter((result) => result.task !== null);
    const misses = [first, second].filter((result) => result.task === null);
    expect(wins).toHaveLength(1);
    expect(misses).toHaveLength(1);
    expect(misses[0]?.reason).toBe('no_ready_task');

    // 落库侧：该任务只有 1 条 RUNNING，run_count 只加了 1，号位只发了 1 个。
    expect(await h.prisma.taskRun.count()).toBe(1);
    expect(await h.prisma.taskRun.count({ where: { status: 'RUNNING' } })).toBe(1);
    const task = await taskRow('T-1');
    expect(task.runCount).toBe(1);
    expect(await runRow('run')).toEqual([{ next: 1 }]);
    expect(await h.prisma.auditLog.count({ where: { action: 'run_claim' } })).toBe(1);

    // 胜出方的 lease_id 全程未被覆盖，且 tasks / task_runs 引用同一份值。
    const run = await h.prisma.taskRun.findFirstOrThrow();
    expect(task.leaseId).toBe(wins[0]!.lease!.lease_id);
    expect(run.leaseId).toBe(task.leaseId);
    expect(task.currentRunId).toBe(run.id);
    expect(wins[0]!.lease!.run_id).toBe(run.id);
    expect(task.status).toBe('RUNNING');
  });

  it('连续两次认领领到两个不同任务，可并行执行（验收 12）', async () => {
    await seedTask(h.prisma, 'T-1');
    await seedTask(h.prisma, 'T-2');

    const first = await h.claims.claim(claimInput, agentA);
    const second = await h.claims.claim(claimInput, agentA);

    expect(first.task?.id).toBe('T-1');
    expect(second.task?.id).toBe('T-2');
    expect(first.lease!.lease_id).not.toBe(second.lease!.lease_id);
    expect(await h.prisma.taskRun.count({ where: { status: 'RUNNING' } })).toBe(2);
  });

  it('抓取顺序为 pinned DESC, priority ASC, created_at ASC（5.6）', async () => {
    await seedTask(h.prisma, 'T-low', { priority: 1, createdAt: '2026-01-01 00:00:00' });
    await seedTask(h.prisma, 'T-pin', {
      priority: 3,
      pinned: 1,
      createdAt: '2026-01-05 00:00:00',
    });
    await seedTask(h.prisma, 'T-early', { priority: 1, createdAt: '2026-01-02 00:00:00' });

    const order: string[] = [];
    for (let i = 0; i < 3; i += 1) {
      const result = await h.claims.claim(claimInput, agentA);
      // 已领走的任务留在执行中列，天然退出候选集——正好测出真实抓取顺序。
      if (!result.task) break;
      order.push(result.task.id);
    }

    expect(order).toEqual(['T-pin', 'T-low', 'T-early']);
  });

  it('blocks 前置未完成时不可见也不可领，前置 DONE 后解锁（验收 11 的依赖侧）', async () => {
    await seedTask(h.prisma, 'T-pre', { status: 'BACKLOG' });
    await seedTask(h.prisma, 'T-follow');
    await h.prisma.taskDependency.create({
      data: { id: newId(), taskId: 'T-follow', dependsOn: 'T-pre', type: 'blocks' },
    });

    const blocked = await h.claims.claim(claimInput, agentA);
    expect(blocked).toEqual({ task: null, reason: 'no_ready_task' });
    expect(await h.prisma.taskRun.count()).toBe(0);

    await h.prisma.task.update({ where: { id: 'T-pre' }, data: { status: 'DONE' } });
    const unlocked = await h.claims.claim(claimInput, agentA);
    expect(unlocked.task?.id).toBe('T-follow');
  });

  it('relates 依赖不参与阻塞判定', async () => {
    await seedTask(h.prisma, 'T-rel', { status: 'BACKLOG' });
    await seedTask(h.prisma, 'T-follow');
    await h.prisma.taskDependency.create({
      data: { id: newId(), taskId: 'T-follow', dependsOn: 'T-rel', type: 'relates' },
    });

    expect((await h.claims.claim(claimInput, agentA)).task?.id).toBe('T-follow');
  });

  it('归档任务不参与认领，空队列返回 no_ready_task 且不写任何行', async () => {
    await seedTask(h.prisma, 'T-arch', { archivedAt: '2026-01-01 00:00:00' });

    const result = await h.claims.claim(claimInput, agentA);
    expect(result).toEqual({ task: null, reason: 'no_ready_task' });
    expect(await h.prisma.taskRun.count()).toBe(0);
    expect(await h.prisma.auditLog.count()).toBe(0);
    expect(await runRow('run')).toEqual([{ next: 0 }]);
  });

  it('已有有效租约的任务不会被第二次认领', async () => {
    await seedTask(h.prisma, 'T-1');
    const first = await h.claims.claim(claimInput, agentA);
    expect(first.task?.id).toBe('T-1');

    const second = await h.claims.claim(claimInput, agentB);
    expect(second.task).toBeNull();
    expect((await taskRow('T-1')).leaseId).toBe(first.lease!.lease_id);
  });

  it('同任务已存在进行中 Run 时以显式错误收场，且回滚不留部分写入（11 章兜底索引）', async () => {
    await seedTask(h.prisma, 'T-1');
    await h.prisma.taskRun.create({
      data: { id: 'R-legacy', taskId: 'T-1', runNumber: 1, status: 'RUNNING', leaseId: newId() },
    });

    await expect(h.claims.claim(claimInput, agentA)).rejects.toMatchObject({
      code: 'TASK_RUNNING',
      status: 409,
    });

    const task = await taskRow('T-1');
    expect(task.status).toBe('READY');
    expect(task.leaseId).toBeNull();
    expect(task.currentRunId).toBeNull();
    expect(task.runCount).toBe(0);
    expect(await h.prisma.taskRun.count({ where: { id: 'R-legacy' } })).toBe(1);
    expect(await runRow('run')).toEqual([{ next: 0 }]);
    expect(await h.prisma.auditLog.count()).toBe(0);
  });

  it('认领载荷带 12 章要求的依赖分组与审核意见字段', async () => {
    await seedTask(h.prisma, 'T-1', { tags: '["backend"]', customFields: '{"env":"staging"}' });
    await seedTask(h.prisma, 'T-pre', { status: 'DONE', title: '前置任务' });
    await h.prisma.taskDependency.create({
      data: { id: newId(), taskId: 'T-1', dependsOn: 'T-pre', type: 'blocks' },
    });

    const result = await h.claims.claim(claimInput, agentA);
    const task = result.task!;
    expect(task.tags).toEqual(['backend']);
    expect(task.custom_fields).toEqual({ env: 'staging' });
    expect(task.dependencies.blocks).toEqual([{ id: 'T-pre', title: '前置任务' }]);
    expect(task.dependencies.relates).toEqual([]);
    expect(task.review_feedback).toEqual([]);
    expect(task.status).toBe('RUNNING');
    expect(task.required_capabilities).toEqual([]);
    expect(result.lease!.expires_at).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(result.lease!.ttl_minutes).toBe(30);
  });
});

describe('list_ready_tasks（与认领共用同一套过滤）', () => {
  it('看得见即领得到：列表与认领跳过同一批任务', async () => {
    await seedTask(h.prisma, 'T-free');
    await seedTask(h.prisma, 'T-needs-docker', { required_capabilities: ['tool:docker'] });

    const listed = await h.claims.listReady(listReadyQuerySchema.parse({}), agentA);
    expect(listed.items.map((item) => item.id)).toEqual(['T-free']);
    expect(listed.count).toBe(1);

    const claimed = await h.claims.claim(claimInput, agentA);
    expect(claimed.task?.id).toBe('T-free');
  });
});

/** 认领返回的三元组在写回侧要用，顺手确认 run_id 是 R- 短号、lease_id 是无括号 UUID。 */
it('租约三元组的形态符合 20.1', async () => {
  await seedTask(h.prisma, 'T-1');
  const result = tripleOf(await h.claims.claim(claimInput, agentA));
  expect(result.run_id).toMatch(/^R-\d+$/);
  expect(result.lease_id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-7/);
  expect(result.task_id).toBe('T-1');
});
