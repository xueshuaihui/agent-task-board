import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { ApiException } from '../../contract/errors';
import { claimSchema, progressSchema } from '../agent-inputs';
import { parseToolInput } from '../../mcp/agent-tools';
import type { RequestAuth } from '../../auth/auth.scope';
import { createAgentHarness, seedTask, tripleOf, type AgentHarness } from './temp-db';

/**
 * #6：进度上报的 message-only、服务端单调钳制、最后上报时间与读模型透出。
 * 断言同样先看返回值，再回到库里的行——「进度不回退」与「progress-only 不清消息」
 * 是这一片的两条硬约束，只看响应体测不出来。
 */
let h: AgentHarness;
let agent: RequestAuth;

const CLAIM = claimSchema.parse({});

beforeAll(async () => {
  h = createAgentHarness();
  agent = await h.agent('progress-bot');
}, 30_000);

afterAll(async () => {
  await h.dispose();
});

beforeEach(async () => {
  await h.prisma.notification.deleteMany();
  await h.prisma.artifact.deleteMany();
  await h.prisma.review.deleteMany();
  await h.prisma.auditLog.deleteMany();
  await h.prisma.comment.deleteMany();
  await h.prisma.taskDependency.deleteMany();
  await h.prisma.taskRun.deleteMany();
  await h.prisma.task.deleteMany();
  h.emitted.length = 0;
});

async function claimOne(id = 'T-1') {
  await seedTask(h.prisma, id);
  const result = h.claims.claim(CLAIM, agent);
  return tripleOf(await result);
}

async function runRow(runId: string) {
  return h.prisma.taskRun.findUniqueOrThrow({ where: { id: runId } });
}

function progressEvents() {
  return h.emitted.filter((event) => event.event === 'run.progress');
}

describe('update_progress（#6 契约）', () => {
  it('progress-only：落库 30、记录最后上报时间、事件带生效值', async () => {
    const key = await claimOne();
    h.emitted.length = 0;

    const result = await h.writeback.updateProgress(
      progressSchema.parse({ ...key, progress: 30 }),
      agent,
    );

    expect(result).toMatchObject({
      task_id: 'T-1',
      run_id: key.run_id,
      progress: 30,
      effective_progress: 30,
      clamped: false,
      message: null,
      orphaned: false,
    });
    expect(result.progress_updated_at).toMatch(/^\d{4}-\d{2}-\d{2}T/);

    const run = await runRow(key.run_id);
    expect(run.progress).toBe(30);
    expect(run.progressMsg).toBeNull();
    expect(run.progressUpdatedAt).not.toBeNull();

    const event = progressEvents()[0];
    expect(event?.data).toMatchObject({
      run_id: key.run_id,
      progress: 30,
      message: null,
      clamped: false,
    });
    expect(event?.data.progress_updated_at).toBeTruthy();
  });

  it('message-only：进度不变、消息更新、最后上报时间刷新', async () => {
    const key = await claimOne();
    await h.writeback.updateProgress(progressSchema.parse({ ...key, progress: 30 }), agent);
    // SQLite 时间戳只到秒：把旧值倒填到过去，刷新与否才能断言，而不是靠 sleep 赌秒针。
    await h.prisma.$executeRawUnsafe(
      `UPDATE task_runs SET progress_updated_at = '2020-01-01 00:00:00' WHERE id = ?`,
      key.run_id,
    );

    const result = await h.writeback.updateProgress(
      progressSchema.parse({ ...key, message: '正在跑测试' }),
      agent,
    );

    expect(result).toMatchObject({
      progress: 30,
      effective_progress: 30,
      message: '正在跑测试',
      clamped: false,
    });
    const run = await runRow(key.run_id);
    expect(run.progress).toBe(30);
    expect(run.progressMsg).toBe('正在跑测试');
    expect(run.progressUpdatedAt).not.toBe('2020-01-01 00:00:00');
    expect(run.progressUpdatedAt).not.toBeNull();
  });

  it('progress-only 不清空已有一条消息', async () => {
    const key = await claimOne();
    await h.writeback.updateProgress(
      progressSchema.parse({ ...key, progress: 30, message: '解析 AST' }),
      agent,
    );

    const result = await h.writeback.updateProgress(
      progressSchema.parse({ ...key, progress: 50 }),
      agent,
    );

    expect(result).toMatchObject({ progress: 50, message: '解析 AST', clamped: false });
    const run = await runRow(key.run_id);
    expect(run.progress).toBe(50);
    expect(run.progressMsg).toBe('解析 AST');
  });

  it('倒退上报被钳制：clamped=true、生效值保持 50、库内不回退', async () => {
    const key = await claimOne();
    await h.writeback.updateProgress(progressSchema.parse({ ...key, progress: 50 }), agent);
    h.emitted.length = 0;

    const result = await h.writeback.updateProgress(
      progressSchema.parse({ ...key, progress: 20 }),
      agent,
    );

    expect(result).toMatchObject({
      progress: 50,
      effective_progress: 50,
      clamped: true,
    });
    expect((await runRow(key.run_id)).progress).toBe(50);
    // run.progress 事件携带的也是生效值，不是入参原值。
    expect(progressEvents()[0]?.data).toMatchObject({ progress: 50, clamped: true });
  });

  it('progress 与 message 都缺 → 422 VALIDATION_FAILED', async () => {
    const key = await claimOne();

    const error = (() => {
      try {
        parseToolInput(progressSchema, key);
      } catch (thrown) {
        return thrown;
      }
      return null;
    })();

    expect(error).toBeInstanceOf(ApiException);
    expect((error as ApiException).code).toBe('VALIDATION_FAILED');
    expect((error as ApiException).status).toBe(422);
    expect((error as ApiException).message).toContain(
      '至少提供 progress 或 message 之一（仅报一句话进度时只传 message）',
    );
  });

  it('卡片/详情读模型透出 progress_updated_at', async () => {
    const key = await claimOne();
    await h.writeback.updateProgress(
      progressSchema.parse({ ...key, progress: 30, message: '读模型' }),
      agent,
    );

    const detail = await h.tasks.getDetail('T-1');
    expect(detail.progress).toBe(30);
    expect(detail.progress_msg).toBe('读模型');
    expect(detail.progress_updated_at).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/);
  });

  it('claim 成功回执带 progress_contract（未领到时不带）', async () => {
    await seedTask(h.prisma, 'T-1');
    const claimed = await h.claims.claim(CLAIM, agent);
    expect(claimed.progress_contract).toContain('0-5%');
    expect(claimed.progress_contract).toContain('10-90%');
    expect(claimed.progress_contract).toContain('100%');
    expect(claimed.progress_contract).toContain('2-3 分钟');

    const miss = await h.claims.claim(CLAIM, agent);
    expect(miss.task).toBeNull();
    expect(miss.progress_contract).toBeUndefined();
  });
});
