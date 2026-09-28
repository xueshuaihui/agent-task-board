import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { ApiException } from '../../contract/errors';
import type { RequestAuth } from '../../auth/auth.scope';
import {
  appendLogSchema,
  blockedSchema,
  claimSchema,
  completeSchema,
  failSchema,
  heartbeatSchema,
  progressSchema,
} from '../agent-inputs';
import { createAgentHarness, seedTask, tripleOf, type AgentHarness } from './temp-db';

/**
 * 4.3.2 的七个分支。断言的统一模式是「先断错误码与 HTTP 状态，再断库里到底写了什么」——
 * 这一节的契约价值全在「结果未写入」这五个字上，只看返回值测不出来。
 */
let h: AgentHarness;
let agent: RequestAuth;

const CLAIM = claimSchema.parse({});

beforeAll(async () => {
  h = createAgentHarness();
  agent = await h.agent('claude-code', ['tool:git']);
});

afterAll(async () => {
  await h.dispose();
});

beforeEach(async () => {
  await h.prisma.notification.deleteMany();
  await h.prisma.artifact.deleteMany();
  await h.prisma.review.deleteMany();
  await h.prisma.auditLog.deleteMany();
  await h.prisma.comment.deleteMany();
  await h.prisma.taskRun.deleteMany();
  await h.prisma.task.deleteMany();
  h.emitted.length = 0;
});

/** 认领一个 READY 任务并返回写回三元组；顺手清空事件捕获，让下面的断言只数回写产生的事件。 */
async function claimOne(id = 'T-1') {
  await seedTask(h.prisma, id);
  const result = await h.claims.claim(CLAIM, agent);
  h.emitted.length = 0;
  return tripleOf(result);
}

function events(name: string) {
  return h.emitted.filter((event) => event.event === name);
}

describe('正常持有 → complete_task', () => {
  it('200 转待审核：租约清空但 current_run_id 保留', async () => {
    const key = await claimOne();

    const result = await h.writeback.complete(completeSchema.parse({ ...key, summary: '改完 3 个文件' }), agent);

    expect(result.run_status).toBe('SUCCESS');
    expect(result.task_status).toBe('REVIEW');
    expect(result.idempotent).toBe(false);
    const task = await h.prisma.task.findUniqueOrThrow({ where: { id: 'T-1' } });
    expect(task.status).toBe('REVIEW');
    expect(task.leaseId).toBeNull();
    expect(task.leaseExpiresAt).toBeNull();
    // 审核表单靠 current_run_id 定位被审的 Run，清掉就断链了。
    expect(task.currentRunId).toBe(key.run_id);
    expect(await h.prisma.notification.count({ where: { kind: 'review_pending' } })).toBe(1);
    expect(events('task.moved')).toHaveLength(1);
    expect(await h.prisma.comment.count({ where: { type: 'status_change' } })).toBe(1);
  });

  it('link 产物由回写落库，普通产物必须先经上传接口（20.6）', async () => {
    const key = await claimOne();
    await h.writeback.complete(
      completeSchema.parse({
        ...key,
        artifacts: [{ type: 'link', uri: 'https://example.com/pr/1', name: 'PR #1' }],
      }),
      agent,
    );

    const artifact = await h.prisma.artifact.findFirstOrThrow();
    expect(artifact).toMatchObject({ runId: key.run_id, taskId: 'T-1', type: 'link' });
    expect(JSON.parse(artifact.metadata ?? '{}').name).toBe('PR #1');
  });

  it('引用未上传的产物 → 422，任务状态与 Run 一律不动', async () => {
    const key = await claimOne();
    const error = await h.writeback
      .complete(
        completeSchema.parse({
          ...key,
          artifacts: [{ type: 'file', uri: 'out/report.md', name: 'report.md' }],
        }),
        agent,
      )
      .catch((thrown: unknown) => thrown);

    expect(error).toBeInstanceOf(ApiException);
    expect((error as ApiException).code).toBe('VALIDATION_FAILED');
    expect((error as ApiException).status).toBe(422);
    expect(await h.prisma.artifact.count()).toBe(0);
    expect((await h.prisma.taskRun.findUniqueOrThrow({ where: { id: key.run_id } })).status).toBe(
      'RUNNING',
    );
    expect((await h.prisma.task.findUniqueOrThrow({ where: { id: 'T-1' } })).status).toBe('RUNNING');
  });
});

describe('审核方式三分流（0020 草案 §3.4）', () => {
  /** 认领一支指定 `review_mode` 的任务：分流只看任务上那一列，其余链路与 human 支同源。 */
  async function claimWithMode(mode: 'human' | 'auto' | 'none') {
    await seedTask(h.prisma, 'T-1', { reviewMode: mode });
    const key = tripleOf(await h.claims.claim(CLAIM, agent));
    h.emitted.length = 0;
    return key;
  }

  it('human：REVIEW + 轨道 human，通知与评论逐字沿用原口径', async () => {
    const key = await claimWithMode('human');

    const result = await h.writeback.complete(completeSchema.parse({ ...key, summary: '人审' }), agent);

    expect(result.task_status).toBe('REVIEW');
    const task = await h.prisma.task.findUniqueOrThrow({ where: { id: 'T-1' } });
    expect(task.status).toBe('REVIEW');
    expect(task.reviewMode).toBe('human');
    expect(task.reviewTrack).toBe('human');
    // 审核表单靠 current_run_id 定位被审 Run，human 支不能动它。
    expect(task.currentRunId).toBe(key.run_id);
    expect(await h.prisma.notification.count({ where: { kind: 'review_pending' } })).toBe(1);
    expect(await h.prisma.notification.count({ where: { kind: 'review_auto_pending' } })).toBe(0);
    expect(
      await h.prisma.comment.count({ where: { content: 'Agent 已完成执行，进入待审核：人审' } }),
    ).toBe(1);
    expect(events('task.moved')[0]?.data).toEqual({ id: 'T-1', from: 'RUNNING', to: 'REVIEW' });
  });

  it('auto：REVIEW + 轨道 auto，推「等待自动审核」而不是 review_pending', async () => {
    const key = await claimWithMode('auto');

    const result = await h.writeback.complete(completeSchema.parse({ ...key, summary: '机审' }), agent);

    // auto 此刻只是「等待自动审核」，还没通过——目标状态仍是 REVIEW（通过通知归 A2）。
    expect(result.task_status).toBe('REVIEW');
    const task = await h.prisma.task.findUniqueOrThrow({ where: { id: 'T-1' } });
    expect(task.status).toBe('REVIEW');
    expect(task.reviewTrack).toBe('auto');
    expect(await h.prisma.notification.count({ where: { kind: 'review_auto_pending' } })).toBe(1);
    expect(await h.prisma.notification.count({ where: { kind: 'review_pending' } })).toBe(0);
    expect(
      await h.prisma.comment.count({ where: { content: 'Agent 已完成执行，进入待自动审核：机审' } }),
    ).toBe(1);
    expect(events('task.moved')[0]?.data).toEqual({ id: 'T-1', from: 'RUNNING', to: 'REVIEW' });
  });

  it('none：直接 DONE 不经 REVIEW，评论与审计显式记录免审核直通', async () => {
    const key = await claimWithMode('none');

    const result = await h.writeback.complete(
      completeSchema.parse({ ...key, summary: '免审直通' }),
      agent,
    );

    expect(result.task_status).toBe('DONE');
    const task = await h.prisma.task.findUniqueOrThrow({ where: { id: 'T-1' } });
    expect(task.status).toBe('DONE');
    expect(task.leaseId).toBeNull();
    expect(task.leaseExpiresAt).toBeNull();
    // 与审核通过出口对齐：DONE 是终态，不留指向已结案 Run 的 current_run_id。
    expect(task.currentRunId).toBeNull();
    expect(task.reviewTrack).toBe('human');

    const comment = await h.prisma.comment.findFirstOrThrow({ where: { type: 'status_change' } });
    expect(comment.content).toContain('免审核直通（review_mode=none）');
    const transition = await h.prisma.auditLog.findFirstOrThrow({ where: { action: 'task_transition' } });
    expect(JSON.parse(String(transition.after))).toMatchObject({
      status: 'DONE',
      review_mode: 'none',
      reason: '免审核直通（review_mode=none）',
    });
    expect(await h.prisma.notification.count({ where: { kind: 'review_pending' } })).toBe(0);
    expect(await h.prisma.notification.count({ where: { kind: 'review_auto_pending' } })).toBe(0);
    expect(events('task.moved')[0]?.data).toEqual({ id: 'T-1', from: 'RUNNING', to: 'DONE' });
  });

  it('none：DONE 后置链照常跑——下游解锁与 task_unblocked 通知不被绕开', async () => {
    const key = await claimWithMode('none');
    await seedTask(h.prisma, 'T-2', { status: 'READY' });
    await h.tasks.addDependency('T-2', 'T-1', 'blocks');
    h.emitted.length = 0;
    await h.prisma.notification.deleteMany();

    await h.writeback.complete(completeSchema.parse({ ...key, summary: '直通' }), agent);

    expect(await h.prisma.task.findUniqueOrThrow({ where: { id: 'T-1' } })).toMatchObject({
      status: 'DONE',
    });
    expect(events('task.unblocked')).toHaveLength(1);
    expect(events('task.moved')[0]?.data).toEqual({ id: 'T-1', from: 'RUNNING', to: 'DONE' });
    expect(await h.prisma.notification.count({ where: { kind: 'task_unblocked' } })).toBe(1);
  });

  it('回写前快照的 review_mode 缺省（历史行）按 human 处理', async () => {
    await seedTask(h.prisma, 'T-1');
    // 0020 之前造的行走迁移默认值，回写路径不因为列缺失而改判分支。
    expect((await h.prisma.task.findUniqueOrThrow({ where: { id: 'T-1' } })).reviewMode).toBe('human');
    const key = tripleOf(await h.claims.claim(CLAIM, agent));

    const result = await h.writeback.complete(completeSchema.parse(key), agent);

    expect(result.task_status).toBe('REVIEW');
    expect(await h.prisma.notification.count({ where: { kind: 'review_pending' } })).toBe(1);
  });
});

describe('重复回写（验收 35）', () => {
  it('同 run_id 二次 complete 返回幂等成功：不新增 Run、不重复通知', async () => {
    const key = await claimOne();
    const input = completeSchema.parse({ ...key, summary: '第一次' });

    const first = await h.writeback.complete(input, agent);
    const second = await h.writeback.complete(input, agent);

    expect(first.idempotent).toBe(false);
    expect(second.idempotent).toBe(true);
    expect(second.run_id).toBe(key.run_id);
    expect(second.task_status).toBe('REVIEW');
    expect(await h.prisma.taskRun.count()).toBe(1);
    expect(await h.prisma.notification.count({ where: { kind: 'review_pending' } })).toBe(1);
    expect(events('task.moved')).toHaveLength(1);
    expect(await h.prisma.taskRun.count({ where: { status: 'SUCCESS' } })).toBe(1);
  });

  it('link 产物按 uri 去重，重试不堆重复行', async () => {
    const key = await claimOne();
    const input = completeSchema.parse({
      ...key,
      artifacts: [{ type: 'link', uri: 'https://example.com/pr/2', name: 'PR #2' }],
    });
    await h.writeback.complete(input, agent);
    await h.writeback.complete(input, agent);
    expect(await h.prisma.artifact.count()).toBe(1);
  });
});

describe('租约过期（验收 13）', () => {
  it('过期未回收时回写：同一判定内先回收，再 410，产物与摘要不入库', async () => {
    const key = await claimOne();
    await h.prisma.$executeRawUnsafe(
      `UPDATE tasks SET lease_expires_at = datetime('now', '-31 minutes') WHERE id = 'T-1'`,
    );

    const error = await h.writeback
      .complete(
        completeSchema.parse({
          ...key,
          summary: '过期结果',
          artifacts: [{ type: 'link', uri: 'https://example.com/pr/3', name: 'PR #3' }],
        }),
        agent,
      )
      .catch((thrown: unknown) => thrown);

    expect((error as ApiException).code).toBe('LEASE_EXPIRED');
    expect((error as ApiException).status).toBe(410);
    const task = await h.prisma.task.findUniqueOrThrow({ where: { id: 'T-1' } });
    expect(task.status).toBe('FAILED');
    expect(task.stopReason).toBe('lease_expired');
    expect(task.leaseId).toBeNull();
    const run = await h.prisma.taskRun.findUniqueOrThrow({ where: { id: key.run_id } });
    expect(run.status).toBe('FAILED');
    expect(run.summary).toBeNull();
    expect(await h.prisma.artifact.count()).toBe(0);
  });

  it('已被扫描回收后回写：410，且不覆盖回收写入的状态与 stop_reason', async () => {
    const key = await claimOne();
    await h.prisma.$executeRawUnsafe(
      `UPDATE tasks SET lease_expires_at = datetime('now', '-31 minutes') WHERE id = 'T-1'`,
    );
    await h.leases.reclaimExpired();

    const expired = await h.writeback
      .fail(failSchema.parse({ ...key, error: '我失败了' }), agent)
      .catch((thrown: unknown) => thrown);
    expect((expired as ApiException).code).toBe('LEASE_EXPIRED');
    expect((expired as ApiException).status).toBe(410);

    const task = await h.prisma.task.findUniqueOrThrow({ where: { id: 'T-1' } });
    expect(task.status).toBe('FAILED');
    expect(task.stopReason).toBe('lease_expired');
    expect(await h.prisma.notification.count({ where: { kind: 'run_failed' } })).toBe(0);
    expect(await h.prisma.comment.count({ where: { authorType: 'agent' } })).toBe(0);
  });

  it('run_id 不属于该任务 → 410，两条 Run 的进度都未写入', async () => {
    const key = await claimOne();
    await seedTask(h.prisma, 'T-2');
    const other = tripleOf(await h.claims.claim(CLAIM, agent));

    const error = await h.writeback
      .updateProgress(progressSchema.parse({ ...key, run_id: other.run_id, progress: 50 }), agent)
      .catch((thrown: unknown) => thrown);
    expect((error as ApiException).code).toBe('LEASE_EXPIRED');
    expect((await h.prisma.taskRun.findUniqueOrThrow({ where: { id: key.run_id } })).progress).toBeNull();
    expect((await h.prisma.taskRun.findUniqueOrThrow({ where: { id: other.run_id } })).progress).toBeNull();
  });

  it('任务被删除 → 409 TASK_GONE', async () => {
    const key = await claimOne();
    await h.prisma.taskRun.deleteMany({ where: { taskId: 'T-1' } });
    await h.prisma.task.delete({ where: { id: 'T-1' } });

    const error = await h.writeback
      .updateProgress(progressSchema.parse({ ...key, progress: 10 }), agent)
      .catch((thrown: unknown) => thrown);
    expect((error as ApiException).code).toBe('TASK_GONE');
    expect((error as ApiException).status).toBe(409);
  });
});

describe('强制停止（验收 34）', () => {
  /** 复刻 tasks.service.stop 的落库形态，测两侧的租约语义是否真的对得上。 */
  async function forceStop(taskId: string) {
    await h.prisma.$executeRawUnsafe(
      `UPDATE tasks SET status='FAILED', stop_reason='user_stop', lease_revoked_at=datetime('now'),
              current_run_id=NULL WHERE id = ?`,
      taskId,
    );
  }

  it('停止后回写 → 410 LEASE_REVOKED，任务停在异常列、日志不入库', async () => {
    const key = await claimOne();
    await forceStop('T-1');

    const error = await h.writeback
      .appendLog(appendLogSchema.parse({ ...key, lines: ['停止后才回写的一行'] }), agent)
      .catch((thrown: unknown) => thrown);

    expect((error as ApiException).code).toBe('LEASE_REVOKED');
    expect((error as ApiException).status).toBe(410);
    const task = await h.prisma.task.findUniqueOrThrow({ where: { id: 'T-1' } });
    expect(task.status).toBe('FAILED');
    expect(task.stopReason).toBe('user_stop');
    expect(await h.prisma.comment.count({ where: { type: 'log' } })).toBe(0);
  });

  it('吊销优先于过期：租约同时过期时仍回 410 LEASE_REVOKED', async () => {
    const key = await claimOne();
    await forceStop('T-1');
    await h.prisma.$executeRawUnsafe(
      `UPDATE tasks SET lease_expires_at = datetime('now', '-31 minutes') WHERE id = 'T-1'`,
    );

    const error = await h.writeback
      .complete(completeSchema.parse({ ...key, summary: 'x' }), agent)
      .catch((thrown: unknown) => thrown);
    expect((error as ApiException).code).toBe('LEASE_REVOKED');
  });
});

describe('孤儿回写（验收 36）', () => {
  /** 任务被人工移走但租约仍未过期：状态已非 RUNNING，租约三要素都还对得上。 */
  async function moveByHand(status: string) {
    const key = await claimOne();
    await h.prisma.$executeRawUnsafe(
      `UPDATE tasks SET status = ?, current_run_id = NULL WHERE id = 'T-1'`,
      status,
    );
    return key;
  }

  it('complete：Run 置 ABANDONED，产物与摘要仍落库，任务状态不回滚', async () => {
    const key = await moveByHand('BACKLOG');
    const result = await h.writeback.complete(
      completeSchema.parse({
        ...key,
        summary: '人已经拖走了，结果留档',
        artifacts: [{ type: 'link', uri: 'https://example.com/pr/9', name: 'PR #9' }],
      }),
      agent,
    );

    expect(result.orphaned).toBe(true);
    expect(result.run_status).toBe('ABANDONED');
    expect(result.task_status).toBe('BACKLOG');
    const run = await h.prisma.taskRun.findUniqueOrThrow({ where: { id: key.run_id } });
    expect(run.status).toBe('ABANDONED');
    expect(run.summary).toBe('人已经拖走了，结果留档');
    expect(run.finishedAt).not.toBeNull();
    expect(await h.prisma.artifact.count()).toBe(1);
    expect((await h.prisma.task.findUniqueOrThrow({ where: { id: 'T-1' } })).status).toBe('BACKLOG');
    expect(events('task.moved')).toHaveLength(0);
    expect(await h.prisma.notification.count()).toBe(0);
  });

  it('append_log：孤儿回写的日志仍可查，任务不回滚为 RUNNING', async () => {
    const key = await moveByHand('BACKLOG');
    const log = await h.writeback.appendLog(
      appendLogSchema.parse({ ...key, lines: ['孤儿日志一', '孤儿日志二'] }),
      agent,
    );
    expect(log.orphaned).toBe(true);
    expect(await h.prisma.comment.count({ where: { type: 'log', runId: key.run_id } })).toBe(2);
    expect((await h.prisma.task.findUniqueOrThrow({ where: { id: 'T-1' } })).status).toBe('BACKLOG');
  });

  it('fail：孤儿回写只补 Run 的错误信息，不覆盖人的操作结果', async () => {
    const key = await moveByHand('BACKLOG');
    const result = await h.writeback.fail(failSchema.parse({ ...key, error: '跑挂了' }), agent);

    expect(result.orphaned).toBe(true);
    expect(result.task_status).toBe('BACKLOG');
    const run = await h.prisma.taskRun.findUniqueOrThrow({ where: { id: key.run_id } });
    expect(run.status).toBe('ABANDONED');
    expect(run.error).toBe('跑挂了');
    expect(run.finishedAt).not.toBeNull();
    expect((await h.prisma.task.findUniqueOrThrow({ where: { id: 'T-1' } })).stopReason).toBeNull();
  });
});

describe('进度、日志与心跳', () => {
  it('update_progress 写进 Run 并广播 run.progress', async () => {
    const key = await claimOne();
    const result = await h.writeback.updateProgress(
      progressSchema.parse({ ...key, progress: 42, message: '解析 AST' }),
      agent,
    );
    expect(result).toMatchObject({ task_id: 'T-1', run_id: key.run_id, progress: 42, orphaned: false });
    const run = await h.prisma.taskRun.findUniqueOrThrow({ where: { id: key.run_id } });
    expect(run).toMatchObject({ progress: 42, progressMsg: '解析 AST' });
    expect(events('run.progress')).toHaveLength(1);
  });

  it('append_log 的作者名取 Token 名，不接受自报（20.8）', async () => {
    const key = await claimOne();
    await h.writeback.appendLog(appendLogSchema.parse({ ...key, lines: ['开始', '结束'] }), agent);
    const rows = await h.prisma.comment.findMany({ where: { type: 'log' } });
    expect(rows.map((row) => row.content).sort()).toEqual(['开始', '结束'].sort());
    expect(new Set(rows.map((row) => row.authorName))).toEqual(new Set(['claude-code']));
    expect(new Set(rows.map((row) => row.authorType))).toEqual(new Set(['agent']));
  });

  it('heartbeat 把租约推后一个 ttl，并回心跳节奏（4.3.2）', async () => {
    const key = await claimOne();
    await h.prisma.$executeRawUnsafe(
      `UPDATE tasks SET lease_expires_at = datetime('now', '+1 minutes') WHERE id = 'T-1'`,
    );

    const result = await h.leases.heartbeat(heartbeatSchema.parse(key), agent);
    expect(result.ttl_minutes).toBe(30);
    expect(result.heartbeat_interval_seconds).toBe(300);
    const task = await h.prisma.task.findUniqueOrThrow({ where: { id: 'T-1' } });
    // 文本时间戳同为 UTC（`YYYY-MM-DD HH:MM:SS`），字典序即时间序。
    const threshold = new Date(Date.now() + 25 * 60_000).toISOString().slice(0, 19).replace('T', ' ');
    expect(task.leaseExpiresAt! > threshold).toBe(true);
  });
});

/**
 * 廿二 A（2026-09-28 拍板）：fail_task 的 BLOCKED 受控分支。
 * 根因：blocked() 把 task.lease_id 清成 NULL 后，verify() 的 `task.leaseId !== input.lease_id`
 * 对 BLOCKED 恒 410——Agent 继续同一会话再判失败时结论写不回（需求.md 廿二章根因链 2）。
 * 受控分支四条件：run 属本任务 ∧ run.lease_id == 入参 ∧ run 由本次 Token 持有 ∧ 任务 BLOCKED；
 * 任一不满足必须维持既有 410 语义，不新造错误码。
 */
describe('BLOCKED 受控分支的 fail_task（廿二 A）', () => {
  /** 先认领再 block，返回 block 前那份三元组——受控分支吃的就是它。 */
  async function claimAndBlock(id = 'T-1') {
    await seedTask(h.prisma, id);
    const key = tripleOf(await h.claims.claim(CLAIM, agent));
    await h.writeback.blocked(
      blockedSchema.parse({
        ...key,
        block_id: 'h1',
        block_title: '人工确认',
        instruction: '等人工回话',
      }),
      agent,
    );
    h.emitted.length = 0;
    return key;
  }

  it('block 后同三元组同 Token fail_task：BLOCKED→FAILED，评论/审计/通知/事件全链落地', async () => {
    const key = await claimAndBlock();

    const result = await h.writeback.fail(
      failSchema.parse({ ...key, error: '确认无解，判定失败', summary: '窗口等不到' }),
      agent,
    );
    expect(result).toMatchObject({
      task_id: 'T-1',
      run_id: key.run_id,
      run_status: 'FAILED',
      task_status: 'FAILED',
      orphaned: false,
    });

    const task = await h.prisma.task.findUniqueOrThrow({ where: { id: 'T-1' } });
    // 看板列归属：6.1 的「异常/失败」列（status 即列，FAILED 不再滞留在阻塞列）。
    expect(task.status).toBe('FAILED');
    expect(task.stopReason).toBe('agent_reported');
    // 租约三元组在 block 时已清空，本分支不写它们（也不该被写回）。
    expect([task.leaseId, task.leaseExpiresAt, task.currentRunId]).toEqual([null, null, null]);

    const run = await h.prisma.taskRun.findUniqueOrThrow({ where: { id: key.run_id } });
    // Run 不回写状态（block 已 FAILED 收口），error 是追加式：block 原文与失败结论都在。
    expect(run.status).toBe('FAILED');
    expect(run.error).toContain('人工块「人工确认」等待人工处理：等人工回话');
    expect(run.error).toContain('Agent 在阻塞中上报失败：确认无解，判定失败');

    const statusComments = await h.prisma.comment.findMany({ where: { type: 'status_change' } });
    expect(statusComments).toHaveLength(2);
    expect(statusComments.map((row) => row.content).join('\n')).toContain(
      'Agent 在阻塞中上报失败，任务由「人工阻塞」转「异常/失败」：确认无解，判定失败',
    );

    const audits = await h.prisma.auditLog.findMany({ where: { action: 'run_writeback' } });
    const closing = audits.map((row) => ({
      before: JSON.parse(row.before ?? '{}'),
      after: JSON.parse(row.after ?? '{}'),
      actorType: row.actorType,
      targetType: row.targetType,
      targetId: row.targetId,
    }));
    expect(closing).toEqual(
      expect.arrayContaining([
        {
          before: { task_status: 'BLOCKED' },
          after: { task_status: 'FAILED' },
          actorType: 'agent',
          targetType: 'run',
          targetId: key.run_id,
        },
      ]),
    );

    expect(await h.prisma.notification.count({ where: { kind: 'run_failed' } })).toBe(1);
    expect(events('task.moved')).toHaveLength(1);
    expect(events('task.moved')[0]!.data).toMatchObject({ id: 'T-1', from: 'BLOCKED', to: 'FAILED' });
    expect(events('task.updated')).toHaveLength(1);
  });

  it('四条件各破一个仍 410：错 lease_id / 错 Token / run 不属本任务，任务留在 BLOCKED', async () => {
    const key = await claimAndBlock();
    // 错 run 归属需要另一条任务的真 Run（同 Token 也越不过 run.taskId 这一查）。
    await seedTask(h.prisma, 'T-2');
    const other = tripleOf(await h.claims.claim(CLAIM, agent));
    const otherAgent = await h.agent('other-bot', ['tool:git']);
    // 认领 T-2 自身会广播一条 task.moved，清掉——下面只数三次被拒的 fail 有没有偷发事件。
    h.emitted.length = 0;

    const attempts: Array<{ label: string; run: typeof key; auth: RequestAuth }> = [
      { label: '错 lease_id', run: { ...key, lease_id: '00000000-0000-4000-8000-000000000000' }, auth: agent },
      { label: '错 Token', run: key, auth: otherAgent },
      { label: 'run 属另一任务', run: { ...other, task_id: 'T-1' }, auth: agent },
    ];
    for (const { label, run, auth } of attempts) {
      const error = await h.writeback
        .fail(failSchema.parse({ ...run, error: `${label} 的失败上报` }), auth)
        .catch((thrown: unknown) => thrown);
      expect((error as ApiException).code, label).toBe('LEASE_EXPIRED');
      expect((error as ApiException).status, label).toBe(410);
    }
    // 三次拒绝都是零写入：任务还停在阻塞列，结案痕迹一条没有。
    const task = await h.prisma.task.findUniqueOrThrow({ where: { id: 'T-1' } });
    expect(task.status).toBe('BLOCKED');
    expect(task.stopReason).toBeNull();
    expect(await h.prisma.notification.count({ where: { kind: 'run_failed' } })).toBe(0);
    expect(events('task.moved')).toHaveLength(0);
  });

  it('结案后重复 fail_task：任务已非 BLOCKED，落回 verify() 的 410 普通拒径（不做幂等回放）', async () => {
    const key = await claimAndBlock();
    await h.writeback.fail(failSchema.parse({ ...key, error: '第一次结案' }), agent);
    h.emitted.length = 0;

    // 裁量（廿二 A 未拍重复语义）：与 blocked()「不做幂等回放」同口径——FAILED 不在受控
    // 分支的入口条件里，直接落回 verify()（lease 已空 → 410），不给已结案任务再开写入窗口。
    const error = await h.writeback
      .fail(failSchema.parse({ ...key, error: '第二次上报' }), agent)
      .catch((thrown: unknown) => thrown);
    expect((error as ApiException).code).toBe('LEASE_EXPIRED');
    expect((error as ApiException).status).toBe(410);

    const task = await h.prisma.task.findUniqueOrThrow({ where: { id: 'T-1' } });
    expect(task.status).toBe('FAILED');
    expect(await h.prisma.notification.count({ where: { kind: 'run_failed' } })).toBe(1);
    expect(events('task.moved')).toHaveLength(0);
    const run = await h.prisma.taskRun.findUniqueOrThrow({ where: { id: key.run_id } });
    expect(run.error).not.toContain('第二次上报');
  });
});
