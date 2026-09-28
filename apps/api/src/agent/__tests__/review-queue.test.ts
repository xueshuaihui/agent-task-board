import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { ApiException } from '../../contract/errors';
import type { RequestAuth } from '../../auth/auth.scope';
import {
  appendLogSchema,
  claimSchema,
  completeSchema,
  submitReviewSchema,
} from '../agent-inputs';
import { createAgentHarness, seedTask, tripleOf, type AgentHarness } from './temp-db';

/**
 * 0020 草案 §3.3/§3.4（A2）的自动审核队列：`claim_next_review` 领取 + `submit_review` 三值结论。
 * 断言的两条主线——
 *  1. 队列只收 REVIEW ∧ review_mode=auto ∧ review_track=auto ∧ 未归档，且被审 Run 的本 Token
 *     既领不到（§3.3 自审预防）也提交不了（§3.3/Q4 硬闸 SELF_REVIEW_FORBIDDEN）；
 *  2. APPROVE/REJECT 的落库与人工审核**同源**：流转、评论文案、驳回通知都是
 *     `TasksService.submitReview` 那一份，差别只在 reviews 行的 reviewer_type/reviewer_name
 *     和 APPROVE 额外推的一条 `review_auto_passed`（草案 §3.6，人审路径不推）。
 */
let h: AgentHarness;
/** 执行者 Token：跑完那个 Run 的机器，按 Q4 不能审自己。 */
let executor: RequestAuth;
/** 审核者 Token：另一台「自动审核器」。 */
let reviewer: RequestAuth;

const CLAIM = claimSchema.parse({});

beforeAll(async () => {
  h = createAgentHarness();
  executor = await h.agent('exec-bot');
  reviewer = await h.agent('review-bot');
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

/**
 * 造一支「待自动审核」任务：READY/auto 建单 → 执行者认领 → 回一条日志 → complete
 * 走 A1 的分流落在 REVIEW + track=auto（与真机链路同一条，不手改库）。
 */
async function toAutoReview(id = 'T-1') {
  await seedTask(h.prisma, id, { reviewMode: 'auto' });
  const key = tripleOf(await h.claims.claim(CLAIM, executor));
  await h.writeback.appendLog(appendLogSchema.parse({ ...key, lines: ['跑了一条命令'] }), executor);
  await h.writeback.complete(completeSchema.parse({ ...key, summary: '改完了' }), executor);
  h.emitted.length = 0;
  return key;
}

describe('claim_next_review（草案 §3.3 队列）', () => {
  it('空队列：与 claim_next_task 同形状的无可领返回，不抛错', async () => {
    await expect(h.reviewQueue.claimNextReview(reviewer)).resolves.toEqual({
      task: null,
      reason: 'no_ready_task',
    });
  });

  it('领到 auto/auto 任务：载荷复用任务详情 + 被审 Run 摘要 + 执行日志', async () => {
    const key = await toAutoReview();

    const result = await h.reviewQueue.claimNextReview(reviewer);
    if (!result.task) throw new Error('期望领到待自动审核任务');

    expect(result.task.id).toBe('T-1');
    expect(result.task.status).toBe('REVIEW');
    expect(result.review_run?.id).toBe(key.run_id);
    expect(result.review_run?.status).toBe('SUCCESS');
    expect(result.logs.map((log: { content: string }) => log.content)).toContain('跑了一条命令');
    // 只读领取：不动状态、不写占用（无占用位是有意设计，见服务层注释）。
    expect(await h.prisma.task.findUniqueOrThrow({ where: { id: 'T-1' } })).toMatchObject({
      status: 'REVIEW',
      reviewTrack: 'auto',
      leaseId: null,
    });
  });

  it('review_mode=human 的 REVIEW 不进自动队列', async () => {
    await seedTask(h.prisma, 'T-1', { reviewMode: 'human' });
    const key = tripleOf(await h.claims.claim(CLAIM, executor));
    await h.writeback.complete(completeSchema.parse(key), executor);

    await expect(h.reviewQueue.claimNextReview(reviewer)).resolves.toEqual({
      task: null,
      reason: 'no_ready_task',
    });
  });

  it('已换轨 track=human 的任务不再被领取（人优先、防抢跑）', async () => {
    await toAutoReview();
    await h.tasks.escalateToHuman('T-1', { type: 'user' });

    await expect(h.reviewQueue.claimNextReview(reviewer)).resolves.toEqual({
      task: null,
      reason: 'no_ready_task',
    });
  });

  it('已归档任务不入队列', async () => {
    await toAutoReview();
    await h.prisma.task.update({
      where: { id: 'T-1' },
      data: { archivedAt: new Date().toISOString() },
    });

    await expect(h.reviewQueue.claimNextReview(reviewer)).resolves.toEqual({
      task: null,
      reason: 'no_ready_task',
    });
  });

  it('被审 Run 是本 Token 执行的 → 领取侧直接排除；换个 Token 就领到', async () => {
    await toAutoReview();

    await expect(h.reviewQueue.claimNextReview(executor)).resolves.toEqual({
      task: null,
      reason: 'no_ready_task',
    });
    const claimed = await h.reviewQueue.claimNextReview(reviewer);
    expect(claimed.task?.id).toBe('T-1');
  });
});

describe('submit_review：APPROVE/REJECT 与人审同源（§3.3）', () => {
  it('APPROVE → DONE + reviews 行署名 agent + 推 review_auto_passed（§3.6）', async () => {
    const key = await toAutoReview();

    const result = await h.reviewQueue.submit(
      submitReviewSchema.parse({
        task_id: 'T-1',
        conclusion: 'APPROVE',
        suggestion: '产物齐全',
      }),
      reviewer,
    );

    expect(result).toMatchObject({ task_id: 'T-1', conclusion: 'APPROVE', task_status: 'DONE' });
    const task = await h.prisma.task.findUniqueOrThrow({ where: { id: 'T-1' } });
    expect(task).toMatchObject({ status: 'DONE', currentRunId: null, leaseId: null });

    const review = await h.prisma.review.findFirstOrThrow();
    expect(review).toMatchObject({
      taskId: 'T-1',
      runId: key.run_id,
      conclusion: 'APPROVE',
      reviewerType: 'agent',
      reviewerName: 'review-bot',
    });

    // 评论文案与人工审核通过逐字一致（同一条实现）。
    expect(
      await h.prisma.comment.count({ where: { content: '审核通过，已完成（产物齐全）' } }),
    ).toBe(1);
    // 通过专属通知只有 agent 支推；`review_pending` 语义不被污染（complete 只推过 auto_pending）。
    expect(await h.prisma.notification.count({ where: { kind: 'review_auto_passed' } })).toBe(1);
    expect(await h.prisma.notification.count({ where: { kind: 'review_pending' } })).toBe(0);
    const audit = await h.prisma.auditLog.findFirstOrThrow({ where: { action: 'review_submit' } });
    expect(audit).toMatchObject({ actorType: 'agent', actorName: 'review-bot' });
  });

  it('人审回归：不传 reviewer 时行为与上一版逐字一致（user/不署名/不推通过通知）', async () => {
    await seedTask(h.prisma, 'T-1', { reviewMode: 'human' });
    const key = tripleOf(await h.claims.claim(CLAIM, executor));
    await h.writeback.complete(completeSchema.parse(key), executor);
    await h.prisma.notification.deleteMany();

    await h.tasks.submitReview('T-1', { conclusion: 'APPROVE', suggestion: '人过' });

    const review = await h.prisma.review.findFirstOrThrow();
    expect(review).toMatchObject({ reviewerType: 'user', reviewerName: null });
    expect(
      await h.prisma.comment.count({ where: { content: '审核通过，已完成（人过）' } }),
    ).toBe(1);
    expect(await h.prisma.notification.count({ where: { kind: 'review_auto_passed' } })).toBe(0);
  });

  it('REJECT → READY + 人工同文案的驳回链，reviews 行署名 agent', async () => {
    await toAutoReview();

    const result = await h.reviewQueue.submit(
      submitReviewSchema.parse({
        task_id: 'T-1',
        conclusion: 'REJECT',
        suggestion: '补验收说明',
        reason: '产物与描述不符',
        detail: '链接指向空仓库',
        return_to: 'READY',
      }),
      reviewer,
    );

    expect(result).toMatchObject({ task_status: 'READY' });
    expect(await h.prisma.task.findUniqueOrThrow({ where: { id: 'T-1' } })).toMatchObject({
      status: 'READY',
    });
    expect(
      await h.prisma.comment.count({ where: { content: '驳回退回「待执行」（产物与描述不符）' } }),
    ).toBe(1);
    expect(await h.prisma.notification.count({ where: { kind: 'review_rejected' } })).toBe(1);
    expect(await h.prisma.notification.count({ where: { kind: 'review_auto_passed' } })).toBe(0);
    const review = await h.prisma.review.findFirstOrThrow();
    expect(review).toMatchObject({ conclusion: 'REJECT', reviewerType: 'agent', reviewerName: 'review-bot' });
  });

  it('REJECT 缺三字段 → 复用 reviewSchema 的同一份 superRefine：422 且不落库', async () => {
    const key = await toAutoReview();

    const error = await h.reviewQueue
      .submit(submitReviewSchema.parse({ task_id: 'T-1', conclusion: 'REJECT' }), reviewer)
      .catch((thrown: unknown) => thrown);

    expect(error).toBeInstanceOf(ApiException);
    expect((error as ApiException).code).toBe('VALIDATION_FAILED');
    expect((error as ApiException).status).toBe(422);
    expect(await h.prisma.review.count()).toBe(0);
    expect(await h.prisma.notification.count({ where: { kind: 'review_rejected' } })).toBe(0);
    expect(await h.prisma.task.findUniqueOrThrow({ where: { id: 'T-1' } })).toMatchObject({
      status: 'REVIEW',
      currentRunId: key.run_id,
    });
  });

  it('执行者自己提交任何结论 → SELF_REVIEW_FORBIDDEN 403，队列与状态不动', async () => {
    await toAutoReview();

    const error = await h.reviewQueue
      .submit(submitReviewSchema.parse({ task_id: 'T-1', conclusion: 'APPROVE' }), executor)
      .catch((thrown: unknown) => thrown);

    expect(error).toBeInstanceOf(ApiException);
    expect((error as ApiException).code).toBe('SELF_REVIEW_FORBIDDEN');
    expect((error as ApiException).status).toBe(403);
    expect(await h.prisma.review.count()).toBe(0);
    expect(await h.prisma.task.findUniqueOrThrow({ where: { id: 'T-1' } })).toMatchObject({
      status: 'REVIEW',
      reviewTrack: 'auto',
    });
  });

  it('任务不存在 → 404；不在 REVIEW / 不在自动轨 → 409', async () => {
    const missing = await h.reviewQueue
      .submit(submitReviewSchema.parse({ task_id: 'T-404', conclusion: 'APPROVE' }), reviewer)
      .catch((thrown: unknown) => thrown);
    expect((missing as ApiException).code).toBe('NOT_FOUND');

    await seedTask(h.prisma, 'T-2'); // READY，没人审过
    const notReview = await h.reviewQueue
      .submit(submitReviewSchema.parse({ task_id: 'T-2', conclusion: 'APPROVE' }), reviewer)
      .catch((thrown: unknown) => thrown);
    expect((notReview as ApiException).code).toBe('ILLEGAL_TRANSITION');
    expect((notReview as ApiException).status).toBe(409);
    // T-2 挪出认领池：claim 取的是「第一个匹配候选」，留着 READY 的 T-2 会抢走 T-1 的认领。
    await h.prisma.task.update({ where: { id: 'T-2' }, data: { status: 'BACKLOG' } });

    await toAutoReview();
    await h.tasks.escalateToHuman('T-1', { type: 'user' });
    const escalated = await h.reviewQueue
      .submit(submitReviewSchema.parse({ task_id: 'T-1', conclusion: 'APPROVE' }), reviewer)
      .catch((thrown: unknown) => thrown);
    expect((escalated as ApiException).code).toBe('ILLEGAL_TRANSITION');
    expect((escalated as ApiException).message).toContain('已转人工审核');
  });

  it('review_mode=human 的 REVIEW：自动面拒收，归人审通道', async () => {
    await seedTask(h.prisma, 'T-1', { reviewMode: 'human' });
    const key = tripleOf(await h.claims.claim(CLAIM, executor));
    await h.writeback.complete(completeSchema.parse(key), executor);

    const error = await h.reviewQueue
      .submit(submitReviewSchema.parse({ task_id: 'T-1', conclusion: 'APPROVE' }), reviewer)
      .catch((thrown: unknown) => thrown);
    expect(error).toBeInstanceOf(ApiException);
    expect((error as ApiException).code).toBe('ILLEGAL_TRANSITION');
    expect((error as ApiException).message).toContain('review_mode=human');
  });
});

describe('submit_review：ESCALATE 只换轨、不写审核记录（§3.4/Q3）', () => {
  it('ESCALATE → track=human + review_pending + 升级评论；reviews 表零行、任务留在 REVIEW', async () => {
    const key = await toAutoReview();

    const result = await h.reviewQueue.submit(
      submitReviewSchema.parse({
        task_id: 'T-1',
        conclusion: 'ESCALATE',
        reason: '产物口径与描述不一致，需要人判断',
      }),
      reviewer,
    );

    expect(result).toMatchObject({
      task_id: 'T-1',
      conclusion: 'ESCALATE',
      task_status: 'REVIEW',
      review_track: 'human',
    });
    const task = await h.prisma.task.findUniqueOrThrow({ where: { id: 'T-1' } });
    expect(task).toMatchObject({ status: 'REVIEW', reviewTrack: 'human', currentRunId: key.run_id });

    // reviews 的 CHECK 只允许 APPROVE/REJECT：升级不是审核结论，一行都不该写。
    expect(await h.prisma.review.count()).toBe(0);
    expect(
      await h.prisma.comment.count({
        where: { content: '自动审核升级人工（原因：产物口径与描述不一致，需要人判断）' },
      }),
    ).toBe(1);
    expect(await h.prisma.notification.count({ where: { kind: 'review_pending' } })).toBe(1);
    // 换轨后人优先：自动队列不再领取，重复升级也被状态闸挡下。
    await expect(h.reviewQueue.claimNextReview(reviewer)).resolves.toEqual({
      task: null,
      reason: 'no_ready_task',
    });
    const again = await h.reviewQueue
      .submit(submitReviewSchema.parse({ task_id: 'T-1', conclusion: 'ESCALATE', reason: '再试' }), reviewer)
      .catch((thrown: unknown) => thrown);
    expect((again as ApiException).code).toBe('ILLEGAL_TRANSITION');
  });
});
