import { Injectable } from '@nestjs/common';
import type { ClaimReason, TaskStatus, ReviewTrack } from '../contract/enums';
import { ApiException } from '../contract/errors';
import { reviewSchema, type ReviewInput } from '../contract/schemas';
import type { RequestAuth } from '../auth/auth.scope';
import { PrismaService } from '../infra/prisma.service';
import { TasksService } from '../tasks/tasks.service';
import { agentOf } from './agent-auth';
import { AgentQueryService } from './agent-query.service';
import type { AgentTaskPayload } from './agent-task.dto';
import type { SubmitReviewToolInput } from './agent-inputs';

/** 审核载荷里执行日志首页的上限：与 REST 分页 page_size 的顶同量级，审核器不分页翻日志。 */
const REVIEW_LOGS_PAGE_SIZE = 200;

/** `tasks.runs` 的单条 Run 摘要（含产物与审核记录回显），与详情抽屉同一份读取形状。 */
type ReviewRunSummary = Awaited<ReturnType<TasksService['runs']>>['items'][number];
type ReviewLogItem = Awaited<ReturnType<TasksService['runLogs']>>['items'][number];

export type ReviewClaimResult =
  | {
      task: AgentTaskPayload;
      /** 被审 Run 摘要（= 任务的 current_run_id）；含产物数组。 */
      review_run: ReviewRunSummary | null;
      logs: ReviewLogItem[];
    }
  | { task: null; reason: ClaimReason };

export interface ReviewSubmitResult {
  task_id: string;
  conclusion: SubmitReviewToolInput['conclusion'];
  task_status: TaskStatus;
  review_track?: ReviewTrack;
}

/**
 * 0020 草案 §3.3 的自动审核队列（A2）：`claim_next_review` 领取 + `submit_review` 结论落地。
 * 本服务只做队列侧的守卫与载荷组装——APPROVE/REJECT 的流转**全部落在
 * `TasksService.submitReview` 那一条人审同源的通道上，不复制第二套审核实现。
 */
@Injectable()
export class ReviewQueueService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly tasks: TasksService,
    private readonly query: AgentQueryService,
  ) {}

  /**
   * 原子领到一支「待自动审核」任务（只读，不产生占用）。
   *
   * 为什么不加占用位/租约列（本片不起迁移 0021）：本产品是单用户本地应用，并发审核器
   * 数量实际 ≤1，「两支审核器领到同一任务」的最坏损失只是一次白读；真正的幂等闸放在
   * 提交侧——`submitReview` 与 `escalateToHuman` 都以「仍处 REVIEW ∧ 仍 track=auto」为
   * 事务条件复验，慢的一方只会拿到 409，队列不需要锁位。
   */
  async claimNextReview(auth: RequestAuth): Promise<ReviewClaimResult> {
    const agent = agentOf(auth);
    // 自审预防（草案 §3.3）：领取查询**直接排除**被审 Run（current_run_id）的执行者
    // Token == 调用方的任务；提交侧还有一道同样的硬闸（SELF_REVIEW_FORBIDDEN）。
    const rows = await this.prisma.$queryRawUnsafe<{ id: string }[]>(
      `${REVIEW_CANDIDATE_SELECT} LIMIT 1`,
      agent.tokenId,
    );
    const candidate = rows[0];
    if (!candidate) {
      // 与 claim_next_task 同形状的「无可领」：不抛错。reason 词表钉死在 enums.ts 的
      // ClaimReason（本片契约定稿、不动词表），「无可审」分支复用 no_ready_task——
      // 判别以 task 字段本身为空为准，审核器不需要区分两种空队列。
      return { task: null, reason: 'no_ready_task' };
    }

    const task = await this.prisma.task.findUnique({ where: { id: candidate.id } });
    if (!task) return { task: null, reason: 'no_ready_task' };
    // 只读载荷全部复用既有读取（草案 §3.3「别新造查询」）：
    // 任务详情走 AgentQueryService.payload（与 claim_next_task/get_task 同一份），
    // Run 摘要（含产物）与执行日志走 TasksService 的 runs/runLogs（与详情抽屉同一份）。
    const reviewRun = task.currentRunId
      ? ((await this.tasks.runs(task.id)).items.find((run) => run.id === task.currentRunId) ?? null)
      : null;
    const logs = task.currentRunId
      ? (await this.tasks.runLogs(task.currentRunId, 1, REVIEW_LOGS_PAGE_SIZE)).items
      : [];
    return { task: await this.query.payload(task.id), review_run: reviewRun, logs };
  }

  /**
   * `submit_review`（草案 §3.3/§3.4）：三值结论的落点分三路——
   *  - APPROVE/REJECT → 组装成 REST 同款的 `ReviewInput`，先过**同一个** `reviewSchema`
   *    （REJECT 必填三字段的 superRefine 只有一份），再走 `TasksService.submitReview`，
   *    reviews 行带 reviewer_type=agent + Token 名，APPROVE 额外推 `review_auto_passed`；
   *  - ESCALATE → `TasksService.escalateToHuman`（不写 reviews 行，只换轨 + `review_pending`）。
   *
   * 入参没有 `run_id`：被审 Run 恒为 `current_run_id`，否则自审门禁就能被「指到别的 Run」绕开。
   */
  async submit(input: SubmitReviewToolInput, auth: RequestAuth): Promise<ReviewSubmitResult> {
    const agent = agentOf(auth);
    const task = await this.prisma.task.findUnique({ where: { id: input.task_id } });
    if (!task) {
      throw new ApiException('NOT_FOUND', '任务不存在', undefined, { task_id: input.task_id });
    }
    if (task.status !== 'REVIEW') {
      throw new ApiException('ILLEGAL_TRANSITION', '只有待审核的任务可以提交自动审核结论', undefined, {
        task_id: task.id,
        status: task.status,
      });
    }
    if (task.reviewMode !== 'auto') {
      throw new ApiException(
        'ILLEGAL_TRANSITION',
        `该任务 review_mode=${task.reviewMode}，不在自动审核队列；human 请人在 UI 审核，none 不经审核`,
        undefined,
        { task_id: task.id, review_mode: task.reviewMode },
      );
    }
    if (task.reviewTrack !== 'auto') {
      throw new ApiException(
        'ILLEGAL_TRANSITION',
        '该任务已转人工审核（review_track=human），等由人提交结论',
        undefined,
        { task_id: task.id, review_track: task.reviewTrack },
      );
    }

    // 自审硬门禁（Q4 两条硬线之一）：审核者 Token == 被审 Run 的执行者 Token → 403。
    // Run 不存在或无 Token 归属（历史行 tokenId 可空）时不构成利益冲突，放行。
    if (task.currentRunId) {
      const run = await this.prisma.taskRun.findUnique({ where: { id: task.currentRunId } });
      if (run && run.tokenId && run.tokenId === agent.tokenId) {
        throw new ApiException(
          'SELF_REVIEW_FORBIDDEN',
          '不能审核自己执行的任务：被审 Run 由本 Token 认领',
          [
            {
              path: 'task_id',
              code: 'self_review',
              message: '换一个非该 Run 执行者的 Token 调 claim_next_review 再提交',
            },
          ],
          { task_id: task.id, run_id: run.id },
        );
      }
    }

    if (input.conclusion === 'ESCALATE') {
      await this.tasks.escalateToHuman(
        task.id,
        { type: 'agent', name: agent.tokenName },
        // ESCALATE 的 reason 在 zod 里是 reviewSchema 的字符串字段，但 `z.string().optional()`
        // 推断在部分场景会宽到 `string | number`；落点只接受字符串文案，这里显式收窄。
        input.reason === undefined ? undefined : String(input.reason),
      );
      return { task_id: task.id, conclusion: 'ESCALATE', task_status: 'REVIEW', review_track: 'human' };
    }

    const parsed = reviewSchema.safeParse({
      conclusion: input.conclusion,
      suggestion: input.suggestion,
      reason: input.reason,
      detail: input.detail,
      return_to: input.return_to,
      priority_adj: input.priority_adj,
    });
    if (!parsed.success) {
      throw new ApiException(
        'VALIDATION_FAILED',
        `审核表单校验失败：${parsed.error.issues
          .map((issue) => `${issue.path.map(String).join('.') || 'conclusion'}: ${issue.message}`)
          .join('；')}`,
        parsed.error.issues.map((issue) => ({
          path: issue.path.map(String).join('.') || 'conclusion',
          code: issue.code,
          message: issue.message,
        })),
      );
    }
    // 与人工审核同一条实现（草案 §3.3）。`ReviewInput.run_id` 刻意不传：
    // submitReview 回落 task.current_run_id，被审 Run 与上面的自审判定保持同一对象。
    const reviewInput = parsed.data as ReviewInput;
    const dto = await this.tasks.submitReview(task.id, reviewInput, {
      type: 'agent',
      name: agent.tokenName,
    });
    return {
      task_id: task.id,
      conclusion: input.conclusion,
      task_status: dto.status,
      review_track: dto.review_track,
    };
  }
}

/**
 * 队列候选（草案 §3.3）：`status='REVIEW' ∧ review_mode='auto' ∧ review_track='auto' ∧ 未归档`，
 * 排除被审 Run 的执行者 == 调用方的任务。排序沿用 5.6 的认领口径
 * （pinned DESC, priority ASC, created_at ASC），审核器不挑单。
 * track=human 不被领取是「人优先、防抢跑」（§3.4）；换轨后自动重新入列由人 PATCH 决定，
 * 队列侧不猜。
 */
const REVIEW_CANDIDATE_SELECT = `
  SELECT t.id
  FROM tasks t
  WHERE t.status = 'REVIEW'
    AND t.review_mode = 'auto'
    AND t.review_track = 'auto'
    AND t.archived_at IS NULL
    AND NOT EXISTS (
      SELECT 1 FROM task_runs r
      WHERE r.id = t.current_run_id AND r.token_id = ?
    )
  ORDER BY t.pinned DESC, t.priority ASC, t.created_at ASC`;
