import { Body, Controller, Get, HttpCode, Param, Post, Query } from '@nestjs/common';
import { ApiException } from '../contract/errors';
import {
  appendLogSchema,
  blockedSchema,
  claimSchema,
  completeSchema,
  failSchema,
  heartbeatSchema,
  listReadyQuerySchema,
  progressSchema,
  reviewFeedbackLimitSchema,
  type AppendLogInput,
  type BlockedInput,
  type ClaimInput,
  type CompleteInput,
  type FailInput,
  type LeaseTriple,
  type ListReadyInput,
  type ProgressInput,
} from './agent-inputs';
import { Auth, type RequestAuth } from '../auth/auth.scope';
import { AuthScope } from '../auth/auth.scope';
import { zod } from '../infra/zod.pipe';
import { AgentQueryService } from './agent-query.service';
import { ClaimService } from './claim.service';
import { LeaseService } from './lease.service';
import { WritebackService } from './writeback.service';

/**
 * 13 章「任务接口」里属于 Agent 凭证组的八条；跨组拒绝由 AuthGuard 按 @AuthScope 落地。
 * 每个 POST 都显式钉 `@HttpCode(200)`：Nest 对 POST 默认回 201，而 12 章要求未领到是
 * 「HTTP 200 + {task:null}」、9.3 要求重复回写「返回 200 幂等成功」。
 */
@Controller('api/v1')
@AuthScope('agent')
export class AgentController {
  constructor(
    private readonly claims: ClaimService,
    private readonly leases: LeaseService,
    private readonly writeback: WritebackService,
    private readonly query: AgentQueryService,
  ) {}

  @Get('tasks/ready')
  ready(@Query(zod(listReadyQuerySchema)) input: ListReadyInput, @Auth() auth: RequestAuth) {
    return this.claims.listReady(input, auth);
  }

  @Post('tasks/claim')
  @HttpCode(200)
  claim(@Body(zod(claimSchema)) input: ClaimInput, @Auth() auth: RequestAuth) {
    return this.claims.claim(input, auth);
  }

  @Post('tasks/:id/progress')
  @HttpCode(200)
  progress(
    @Param('id') id: string,
    @Body(zod(progressSchema)) input: ProgressInput,
    @Auth() auth: RequestAuth,
  ) {
    assertSameTask(id, input.task_id);
    return this.writeback.updateProgress(input, auth);
  }

  @Post('tasks/:id/logs')
  @HttpCode(200)
  logs(@Param('id') id: string, @Body(zod(appendLogSchema)) input: AppendLogInput, @Auth() auth: RequestAuth) {
    assertSameTask(id, input.task_id);
    return this.writeback.appendLog(input, auth);
  }

  @Post('tasks/:id/complete')
  @HttpCode(200)
  complete(
    @Param('id') id: string,
    @Body(zod(completeSchema)) input: CompleteInput,
    @Auth() auth: RequestAuth,
  ) {
    assertSameTask(id, input.task_id);
    return this.writeback.complete(input, auth);
  }

  @Post('tasks/:id/fail')
  @HttpCode(200)
  fail(@Param('id') id: string, @Body(zod(failSchema)) input: FailInput, @Auth() auth: RequestAuth) {
    assertSameTask(id, input.task_id);
    return this.writeback.fail(input, auth);
  }

  /** 8.4 人工块：Agent 执行到人工块时上报，任务转 BLOCKED，人工处理后回 READY 重新认领。 */
  @Post('tasks/:id/blocked')
  @HttpCode(200)
  blocked(
    @Param('id') id: string,
    @Body(zod(blockedSchema)) input: BlockedInput,
    @Auth() auth: RequestAuth,
  ) {
    assertSameTask(id, input.task_id);
    return this.writeback.blocked(input, auth);
  }

  @Post('tasks/:id/heartbeat')
  @HttpCode(200)
  heartbeat(
    @Param('id') id: string,
    @Body(zod(heartbeatSchema)) input: LeaseTriple,
    @Auth() auth: RequestAuth,
  ) {
    assertSameTask(id, input.task_id);
    return this.leases.heartbeat(input, auth);
  }

  @Get('tasks/:id/review-feedback')
  reviewFeedback(
    @Param('id') id: string,
    @Query(zod(reviewFeedbackLimitSchema)) query: { limit: number },
    @Auth() auth: RequestAuth,
  ) {
    return this.query.reviewFeedback({ task_id: id, limit: query.limit }, auth);
  }
}

/** 路径与三元组双重给定时以路径为准，但两者不一致就是调用方拼错了，不能静默按其一执行。 */
function assertSameTask(pathId: string, bodyId: string): void {
  if (pathId !== bodyId) {
    throw new ApiException(
      'INVALID_PARAM',
      '路径中的任务 ID 与入参 task_id 不一致',
      undefined,
      { task_id: pathId, body_task_id: bodyId },
    );
  }
}
