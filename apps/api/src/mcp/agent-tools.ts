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
import type { SettingsService } from '../infra/settings.service';
import { buildVocabulary } from '../contract/vocabulary';
import { skillListQuerySchema, type SkillListQuery } from '../skills/skills.dto';
import type { SkillsService } from '../skills/skills.service';

/** v0.0.4 W6 §16.1 的技能工具入参：list 沿用 UI 侧的过滤形状；search 关键字必填；get 只要 id。 */
const getSkillSchema = z.object({
  skill_id: z
    .string()
    .trim()
    .min(1)
    .max(64)
    .describe('技能 ID（skl_ 前缀），来自 list_skills/search_skills 的结果；不能按名称直接查（名称查询用 search_skills）'),
});
const searchSkillsSchema = skillListQuerySchema.extend({
  keyword: z
    .string()
    .trim()
    .min(1)
    .max(100)
    .describe('搜索关键字（1-100 字符），必填：命中技能名称与描述，无关键字不要调本工具'),
});

/** B6 词表工具：无入参——一次调用返回服务端当前全部词表口径，agent 不再试错猜值。 */
const getVocabularySchema = z.object({});

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
  /** B6 词表工具：get_vocabulary 需要读设置现值（task_types / agent_creation_mode），与校验同源。 */
  settings: SettingsService;
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
    // ------------------------------------------- B6 词表只读工具：一次拿全口径，杜绝试错造测试数据
    {
      name: 'get_vocabulary',
      description:
        '获取服务端当前全部词表口径（只读、无入参）：任务类型默认与生效词表（含自定义）、优先级 0-3 各级含义、' +
        'confirmation_mode 三模式语义与缺省、任务状态机状态集与允许流转、capability 命名空间规则、' +
        '技能类型/状态/来源、产物类型、日志级别。写 board.create_task / claim 类入参前先调用本工具拿取值，不要试错',
      input: getVocabularySchema,
      run: async (args, auth) => {
        agentOf(auth);
        return buildVocabulary({
          taskTypes: await ctx.settings.get('task_types'),
          agentCreationMode: await ctx.settings.get('agent_creation_mode'),
        });
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
 *
 * B6 报错回显：422 不只是裸 schema 报错——每条 issue 额外带
 *  1. `hint`：从 zod issue 自身数据推出的可接受值/区间（枚举列出全部取值、
 *     数值/字符串/数组给出 min-max 边界、invalid_type 给出期望类型）；
 *  2. 字段级 `.describe()` 文案（按 issue.path 回到 schema 上取），让 agent
 *     不查文档就知道这个字段该怎么填，从源头消灭试错式测试数据。
 */
export function parseToolInput(schema: z.ZodTypeAny, args: unknown): unknown {
  const parsed = schema.safeParse(args ?? {});
  if (!parsed.success) {
    const details = parsed.error.issues.map((issue) => {
      const path = issue.path.map(String).join('.') || '(root)';
      const hints = [expectedFromIssue(issue), findFieldDescription(schema, issue.path)].filter(
        Boolean,
      ) as string[];
      return {
        path,
        code: issue.code,
        message: issue.message,
        ...(hints.length > 0 ? { hint: hints.join('；') } : {}),
      };
    });
    throw new ApiException(
      'VALIDATION_FAILED',
      `入参校验失败：${details
        .map((item) => `${item.path}: ${item.message}${item.hint ? `（${item.hint}）` : ''}`)
        .join('；')}`,
      details,
    );
  }
  return parsed.data;
}

/** 从 zod 4 issue 的结构化数据里榨出「可接受值」提示；榨不出就返回 undefined 不编造。 */
function expectedFromIssue(issue: z.ZodIssue): string | undefined {
  // zod 4 各 issue 分支的附加字段（values/minimum/expected…）只在这里集中收窄一次。
  const data = issue as unknown as Record<string, unknown>;
  switch (issue.code) {
    case 'invalid_value':
      return Array.isArray(data.values)
        ? `可接受值：${data.values.map((value) => JSON.stringify(value)).join(' | ')}`
        : undefined;
    case 'invalid_type':
      return `期望类型 ${String(data.expected ?? '未知')}，实际收到 ${String(data.received ?? '未知')}`;
    case 'too_small':
      return `${originLabel(data.origin)}${data.inclusive === false ? '大于' : '至少'} ${String(data.minimum)}（当前 ${String(data.received ?? data.value ?? '缺失')}）`;
    case 'too_big':
      return `${originLabel(data.origin)}${data.inclusive === false ? '小于' : '至多'} ${String(data.maximum)}（当前 ${String(data.received ?? data.value ?? '缺失')}）`;
    case 'invalid_format':
      return data.pattern
        ? `需匹配格式 ${String(data.format ?? '')} ${String(data.pattern)}`.trim()
        : data.format
          ? `需匹配格式：${String(data.format)}`
          : undefined;
    case 'unrecognized_keys':
      return Array.isArray(data.keys)
        ? `未知字段：${data.keys.join('、')}；只接受 schema 声明的字段`
        : undefined;
    default:
      return undefined;
  }
}

function originLabel(origin: unknown): string {
  if (origin === 'string') return '字符串长度需';
  if (origin === 'number' || origin === 'int') return '数值需';
  if (origin === 'array') return '数组长度需';
  return '取值需';
}

/** zod 4 的内部结构只做只读探测（不改校验行为），统一松散形状。 */
interface LooseNode {
  _zod?: { def?: { type?: string; innerType?: LooseNode } };
  description?: unknown;
  shape?: unknown;
  element?: LooseNode;
  unwrap?: (() => LooseNode) | undefined;
}

/** optional/nullable/default/catch 等包装层：取描述前先剥到底。 */
const WRAPPER_KINDS = new Set([
  'optional',
  'nullable',
  'default',
  'catch',
  'prefault',
  'nonoptional',
  'readonly',
  'branded',
]);

function unwrapNode(node: LooseNode): LooseNode {
  let current = node;
  for (let guard = 0; guard < 12 && current; guard += 1) {
    const kind = current._zod?.def?.type;
    if (!kind || !WRAPPER_KINDS.has(kind)) break;
    current = current.unwrap ? current.unwrap() : (current._zod?.def?.innerType as LooseNode);
  }
  return current;
}

/** `.describe()` 可能挂在包装层上（optional 之后）也可能挂在内层（optional 之前）：自上而下取第一个。 */
function descriptionOf(node: LooseNode | undefined): string | undefined {
  let current = node;
  for (let guard = 0; guard < 12 && current; guard += 1) {
    if (typeof current.description === 'string' && current.description) return current.description;
    const kind = current._zod?.def?.type;
    if (!kind || !WRAPPER_KINDS.has(kind)) return undefined;
    current = current.unwrap ? current.unwrap() : (current._zod?.def?.innerType as LooseNode);
  }
  return undefined;
}

/** 沿 issue.path 回到 schema 上取该字段的 `.describe()` 文案；路径穿不进（union 等）返回 undefined。 */
function findFieldDescription(schema: z.ZodTypeAny, path: z.ZodIssue['path']): string | undefined {
  let node = unwrapNode(schema as unknown as LooseNode);
  for (const segment of path) {
    if (!node) return undefined;
    if (typeof segment === 'number' && node._zod?.def?.type === 'array') {
      const element = node.element as LooseNode;
      const desc = descriptionOf(element);
      if (desc) return desc;
      node = unwrapNode(element);
      continue;
    }
    const shapeValue =
      typeof node.shape === 'function' ? (node.shape as () => unknown)() : node.shape;
    if (typeof segment !== 'string' || typeof shapeValue !== 'object' || shapeValue === null) {
      return undefined;
    }
    const child = (shapeValue as Record<string, LooseNode | undefined>)[segment];
    if (!child) return undefined;
    const desc = descriptionOf(child);
    node = unwrapNode(child);
    if (desc) return desc;
  }
  return undefined;
}
