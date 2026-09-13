import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { ApiException } from '../../contract/errors';
import type { RequestAuth } from '../../auth/auth.scope';
import {
  appendLogSchema,
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
