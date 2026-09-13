import { z } from 'zod';
import { ApiException } from '../contract/errors';
import type { RequestAuth } from '../auth/auth.scope';
import {
  appendLogSchema,
  claimSchema,
  completeSchema,
  failSchema,
  getTaskSchema,
  heartbeatSchema,
  listReadyQuerySchema,
  progressSchema,
  reviewFeedbackQuerySchema,
  type AppendLogInput,
  type ClaimInput,
  type CompleteInput,
  type FailInput,
  type GetTaskInput,
  type LeaseTriple,
  type ListReadyInput,
  type ProgressInput,
  type ReviewFeedbackInput,
} from '../agent/agent-inputs';
import type { AgentQueryService } from '../agent/agent-query.service';
import type { ClaimService } from '../agent/claim.service';
import type { LeaseService } from '../agent/lease.service';
import type { WritebackService } from '../agent/writeback.service';

export interface AgentToolContext {
  claims: ClaimService;
  leases: LeaseService;
  writeback: WritebackService;
  query: AgentQueryService;
}

export interface AgentTool {
  name: string;
  description: string;
  input: z.ZodObject<z.ZodRawShape>;
  run: (args: unknown, auth: RequestAuth) => Promise<unknown>;
}

/**
 * 12 章的九个工具。业务逻辑全在 Agent 服务层，这里只做「工具名 → 服务方法」的映射，
 * 因此 REST 与 MCP 共用同一套校验与错误语义（13 章错误码只有一份实现）。
 */
export function buildAgentTools(ctx: AgentToolContext): AgentTool[] {
  return [
    {
      name: 'list_ready_tasks',
      description: '查询可领取任务（服务端已过滤阻塞依赖与能力不匹配，只读，不产生租约）',
      input: listReadyQuerySchema,
      run: (args, auth) => ctx.claims.listReady(args as ListReadyInput, auth),
    },
    {
      name: 'claim_next_task',
      description: '原子认领下一个可执行任务并建立租约（9.3）',
      input: claimSchema,
      run: (args, auth) => ctx.claims.claim(args as ClaimInput, auth),
    },
    {
      name: 'get_task',
      description: '获取任务详情（含审核意见、自定义字段、依赖）',
      input: getTaskSchema,
      run: (args, auth) => ctx.query.getTask(args as GetTaskInput, auth),
    },
    {
      name: 'update_progress',
      description: '更新进度，需 task_id + run_id + lease_id 三元组',
      input: progressSchema,
      run: (args, auth) => ctx.writeback.updateProgress(args as ProgressInput, auth),
    },
    {
      name: 'append_log',
      description: '追加执行日志，Agent 只能写 type=log（20.8）',
      input: appendLogSchema,
      run: (args, auth) => ctx.writeback.appendLog(args as AppendLogInput, auth),
    },
    {
      name: 'complete_task',
      description: '完成回写，任务转待审核；同 run_id 重复调用为幂等成功（4.3.2）',
      input: completeSchema,
      run: (args, auth) => ctx.writeback.complete(args as CompleteInput, auth),
    },
    {
      name: 'fail_task',
      description: '失败上报，任务转异常/失败，需三元组',
      input: failSchema,
      run: (args, auth) => ctx.writeback.fail(args as FailInput, auth),
    },
    {
      name: 'heartbeat',
      description: '续租：把 lease_expires_at 推后 lease_ttl_minutes',
      input: heartbeatSchema,
      run: (args, auth) => ctx.leases.heartbeat(args as LeaseTriple, auth),
    },
    {
      name: 'get_review_feedback',
      description: '获取最近审核意见（6.6）',
      input: reviewFeedbackQuerySchema,
      run: (args, auth) => ctx.query.reviewFeedback(args as ReviewFeedbackInput, auth),
    },
  ];
}

/**
 * 入参校验复用 contract/agent-schemas.ts。SDK 的 zod 兼容层负责把 input 转成
 * `tools/list` 的 JSON Schema，这里再 parse 一次，是为了非 HTTP 入口（测试、脚本）
 * 也拿得到同一份 `VALIDATION_FAILED` 结构。
 */
export function parseToolInput(schema: z.ZodTypeAny, args: unknown): unknown {
  const parsed = schema.safeParse(args ?? {});
  if (!parsed.success) {
    throw new ApiException(
      'VALIDATION_FAILED',
      '入参校验失败',
      parsed.error.issues.map((issue) => ({
        path: issue.path.map(String).join('.') || '(root)',
        code: issue.code,
        message: issue.message,
      })),
    );
  }
  return parsed.data;
}
