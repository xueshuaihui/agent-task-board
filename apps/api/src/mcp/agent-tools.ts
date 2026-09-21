import { z } from 'zod';
import { ApiException } from '../contract/errors';
import { agentOf } from '../agent/agent-auth';
import type { RequestAuth } from '../auth/auth.scope';
import {
  appendLogSchema,
  blockedSchema,
  checkMcpPolicySchema,
  claimSchema,
  completeSchema,
  failSchema,
  getTaskSchema,
  heartbeatSchema,
  listReadyQuerySchema,
  progressSchema,
  reportMcpCallSchema,
  reviewFeedbackQuerySchema,
  waitForResumeSchema,
  type AppendLogInput,
  type BlockedInput,
  type CheckMcpPolicyInput,
  type ClaimInput,
  type CompleteInput,
  type FailInput,
  type GetTaskInput,
  type LeaseTriple,
  type ListReadyInput,
  type ProgressInput,
  type ReportMcpCallInput,
  type ReviewFeedbackInput,
  type WaitResumeInput,
} from '../agent/agent-inputs';
import type { AgentQueryService } from '../agent/agent-query.service';
import type { ClaimService } from '../agent/claim.service';
import type { LeaseService } from '../agent/lease.service';
import type { McpPolicyService } from '../agent/mcp-policy.service';
import type { WritebackService } from '../agent/writeback.service';
import {
  skillListQuerySchema,
  type SkillListQuery,
} from '../skills/skills.dto';
import type { SkillsService } from '../skills/skills.service';

/** v0.0.4 W6 §16.1 的技能工具入参：list 沿用 UI 侧的过滤形状；search 关键字必填；get 只要 id。 */
const getSkillSchema = z.object({ skill_id: z.string().trim().min(1).max(64) });
const searchSkillsSchema = skillListQuerySchema.extend({
  keyword: z.string().trim().min(1).max(100),
});

export interface AgentToolContext {
  claims: ClaimService;
  leases: LeaseService;
  writeback: WritebackService;
  query: AgentQueryService;
  /** v0.0.4 W6 §16.1：list_skills / get_skill / search_skills 直接复用 SkillsService 的读侧方法。 */
  skills: SkillsService;
  /** v0.0.4 W6 §12.6：check_mcp_policy / report_mcp_call 的策略裁决与审计落点。 */
  policy: McpPolicyService;
}

export interface AgentTool {
  name: string;
  description: string;
  input: z.ZodObject<z.ZodRawShape>;
  run: (args: unknown, auth: RequestAuth) => Promise<unknown>;
}

/**
 * 12 章的九个基础工具 + v0.0.4 W6 §16.1 的人工块/恢复工具（block_task、wait_for_resume）
 * 与技能三工具（list_skills、get_skill、search_skills，只读，W2 语义由 SkillsService 保证）。
 * 业务逻辑全在 Agent 服务层，这里只做「工具名 → 服务方法」的映射，
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
    {
      name: 'block_task',
      description: '上报人工块：任务转人工阻塞（BLOCKED）等人工处理，租约随之清空（§4.1/§8.4）',
      input: blockedSchema,
      run: (args, auth) => ctx.writeback.blocked(args as BlockedInput, auth),
    },
    {
      name: 'wait_for_resume',
      description: '等待人工处理完成：长轮询直到 BLOCKED 转回其它状态或超时（§16.1）',
      input: waitForResumeSchema,
      run: (args, auth) => ctx.writeback.waitResume(args as WaitResumeInput, auth),
    },
    {
      name: 'list_skills',
      description: '列出技能（§16.1；可按 type/status/tag/source/keyword 过滤，只读，Agent 凭证专属）',
      input: skillListQuerySchema,
      run: async (args, auth) => {
        agentOf(auth);
        return ctx.skills.list(args as SkillListQuery);
      },
    },
    {
      name: 'get_skill',
      description: '获取技能详情（含版本历史与 MCP 依赖，§16.1）',
      input: getSkillSchema,
      run: async (args, auth) => {
        agentOf(auth);
        const { skill_id: skillId } = args as { skill_id: string };
        return ctx.skills.detail(skillId);
      },
    },
    {
      name: 'search_skills',
      description: '按关键字搜索技能（keyword 必填；命中 name/description，§16.1）',
      input: searchSkillsSchema,
      run: async (args, auth) => {
        agentOf(auth);
        return ctx.skills.list(args as SkillListQuery);
      },
    },
    {
      name: 'check_mcp_policy',
      description:
        '调用第三方 MCP 前的策略裁决（§12.4/§12.6；未声明服务器或工具一律拒，落决策审计，Agent 凭证专属）',
      input: checkMcpPolicySchema,
      run: (args, auth) => ctx.policy.check(args as CheckMcpPolicyInput, auth),
    },
    {
      name: 'report_mcp_call',
      description: '上报一次第三方 MCP 调用结果，写入 MCP 审计（§12.6；只落库不回查外键）',
      input: reportMcpCallSchema,
      run: (args, auth) => ctx.policy.report(args as ReportMcpCallInput, auth),
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
