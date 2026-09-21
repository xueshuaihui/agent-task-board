import { z } from 'zod';
import { ApiException } from '../contract/errors';
import { agentOf } from '../agent/agent-auth';
import type { RequestAuth } from '../auth/auth.scope';
import {
  appendLogSchema,
  blockedSchema,
  breakdownBeginSchema,
  breakdownDraftReportSchema,
  breakdownProgressReportSchema,
  breakdownSessionActionSchema,
  checkMcpPolicySchema,
  claimSchema,
  completeSchema,
  createTaskSchema,
  createTasksBatchSchema,
  creationRequestRefSchema,
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
  type BreakdownBeginToolInput,
  type BreakdownDraftReportInput,
  type BreakdownProgressReportInput,
  type BreakdownSessionActionInput,
  type CheckMcpPolicyInput,
  type ClaimInput,
  type CompleteInput,
  type CreateTaskToolInput,
  type CreateTasksBatchInput,
  type CreationRequestRefInput,
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
import type { BreakdownService } from '../breakdown/breakdown.service';
import type { CreationService } from '../creation/creation.service';
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
  /** v0.0.4 W7 §16.1：board.* 拆解五工具的生命周期落点（begin/progress/draft/finish/cancel）。 */
  breakdown: BreakdownService;
  /** v0.0.4 W8 §8.7：board.create_task 的会话创建闭环落点（三模式 + 轻确认决策闭环/状态轮询）。 */
  creation: CreationService;
}

export interface AgentTool {
  name: string;
  description: string;
  input: z.ZodObject<z.ZodRawShape>;
  run: (args: unknown, auth: RequestAuth) => Promise<unknown>;
}

/**
 * 12 章的九个基础工具 + v0.0.4 W6 §16.1 的人工块/恢复工具（block_task、wait_for_resume）
 * 与技能三工具（list_skills、get_skill、search_skills，只读，W2 语义由 SkillsService 保证）
 * + v0.0.4 W7 §16.1 的拆解五工具（board.begin_breakdown / report_progress / report_task_draft /
 * finish_breakdown / cancel_breakdown）
 * + v0.0.4 W8 §8.7 的 board.create_task（直建/静默两模式核心落库；light 决策闭环与
 * board.wait_for_confirmation、get_creation_status 归下一切片）。
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
    // ------------------------------------------- v0.0.4 W7 §16.1：board.* 拆解工具面（Agent 凭证专属）
    {
      name: 'board.begin_breakdown',
      description:
        '发起需求拆解会话（§7.2 阶段 1；传入需求文本、分组、父任务标题、预估任务数，返回 session_id）',
      input: breakdownBeginSchema,
      run: async (args, auth) => {
        const agent = agentOf(auth);
        const input = args as BreakdownBeginToolInput;
        // agent_name 缺省取凭证名：确认页「正在接收 Qoder 的拆解结果」据此渲染（§7.3）。
        return ctx.breakdown.begin({ ...input, agent_name: input.agent_name ?? agent.tokenName });
      },
    },
    {
      name: 'board.report_progress',
      description: '上报拆解进度（§7.2 阶段 3；step/total 正整数且 step ≤ total，会话须处于 receiving）',
      input: breakdownProgressReportSchema,
      run: async (args, auth) => {
        agentOf(auth);
        const { session_id: sessionId, ...rest } = args as BreakdownProgressReportInput;
        await ctx.breakdown.reportProgress(sessionId, rest);
        return { recorded: true };
      },
    },
    {
      name: 'board.report_task_draft',
      description:
        '上报单个任务草案（§7.2 阶段 4；同 ref 重报即覆盖；skill_ids 可填技能名，finish 时统一解析 §7.5）',
      input: breakdownDraftReportSchema,
      run: async (args, auth) => {
        agentOf(auth);
        const { session_id: sessionId, ...rest } = args as BreakdownDraftReportInput;
        return ctx.breakdown.reportDraft(sessionId, rest);
      },
    },
    {
      name: 'board.finish_breakdown',
      description:
        '完成拆解：依赖图校验 + 技能名→ID 解析（§7.5），会话转 reviewing 等用户确认；返回 skill_resolution 告警',
      input: breakdownSessionActionSchema,
      run: async (args, auth) => {
        agentOf(auth);
        const { session_id: sessionId } = args as BreakdownSessionActionInput;
        return ctx.breakdown.finish(sessionId);
      },
    },
    {
      name: 'board.cancel_breakdown',
      description: '取消拆解会话（§7.7；receiving / reviewing 可取消，转 cancelled）',
      input: breakdownSessionActionSchema,
      run: async (args, auth) => {
        agentOf(auth);
        const { session_id: sessionId } = args as BreakdownSessionActionInput;
        return ctx.breakdown.cancel(sessionId);
      },
    },
    // ------------------------------------------- v0.0.4 W8 §8.7：会话创建闭环（Agent 凭证专属）
    {
      name: 'board.create_task',
      description:
        '会话创建单个任务（§8.7；direct/silent 即时落库并记账 agent_sessions/task_creation_logs；' +
        'light 缺省服务端阻塞等待轻确认决策（超时 30s + 5s 宽限，超时不创建），wait:false 走异步立即返回 request_id）',
      input: createTaskSchema,
      run: async (args, auth) => {
        const agent = agentOf(auth);
        const input = args as CreateTaskToolInput;
        // agent_name 缺省取凭证名：来源列与流水都据此记账（同 begin_breakdown 口径）。
        return ctx.creation.createFromAgent(input, agent.tokenName);
      },
    },
    {
      name: 'board.create_tasks_batch',
      description:
        '批量创建任务（§8.7 轻量版；≤20 条，串行逐条复用 create_task 落库与重复检测，单条失败不熔断整批；' +
        'light 条目缺省不阻塞、即时返回 request_id，wait:true 逐条阻塞等决策）',
      input: createTasksBatchSchema,
      run: async (args, auth) => {
        const agent = agentOf(auth);
        const input = args as CreateTasksBatchInput;
        return ctx.creation.createBatchFromAgent(input, input.agent_name?.trim() || agent.tokenName);
      },
    },
    {
      name: 'board.get_creation_status',
      description: '轮询创建请求结果（§8.7 r3，light + wait:false 异步模式的超时降级收口路径）',
      input: creationRequestRefSchema,
      run: async (args, auth) => {
        agentOf(auth);
        const { request_id: requestId } = args as CreationRequestRefInput;
        return ctx.creation.status(requestId);
      },
    },
    {
      name: 'board.wait_for_confirmation',
      description: '阻塞等待创建请求的轻确认决策收口（§8.7；create/edit/cancel/超时，已终结立即返回）',
      input: creationRequestRefSchema,
      run: async (args, auth) => {
        agentOf(auth);
        const { request_id: requestId } = args as CreationRequestRefInput;
        return ctx.creation.waitFor(requestId);
      },
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
