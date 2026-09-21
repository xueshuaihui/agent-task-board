import { z } from 'zod';
import { ARTIFACT_TYPES } from './enums';
import { capabilitySchema, idLike } from './schemas';

const idParam = idLike;

/** 12 章通用契约：除三个只读工具外，写回入参必须带 task_id + run_id + lease_id 三元组。 */
export const leaseTripleSchema = z.object({
  task_id: idParam,
  run_id: idParam,
  lease_id: z.string().uuid(),
});

export const claimSchema = z.object({
  capabilities: z.array(capabilitySchema).max(20).default([]),
  task_types: z.array(z.string().trim().min(1).max(16)).default([]),
});
export type ClaimInput = z.infer<typeof claimSchema>;

export const progressSchema = leaseTripleSchema.extend({
  progress: z.number().int().min(0).max(100),
  message: z.string().trim().max(500).optional(),
});

export const appendLogSchema = leaseTripleSchema.extend({
  /** 单次调用的行数；单 Run 累计上限 5000 行（20.8），超限由服务端做首尾保留截断。 */
  lines: z.array(z.string().max(4000)).min(1).max(500),
  level: z.enum(['debug', 'info', 'warn', 'error']).default('info'),
});

/** 20.6：普通产物引用的是先上传后返回的相对路径；`link` 例外，uri 就是 http(s) 外链。 */
const uploadedArtifactSchema = z.object({
  type: z.enum(ARTIFACT_TYPES).exclude(['link']),
  uri: z
    .string()
    .min(1)
    .max(1024)
    .refine(
      (value) => !value.startsWith('/') && !value.includes('\\') && !value.split('/').includes('..'),
      'uri 需为上传接口返回的相对路径',
    ),
  size_bytes: z.number().int().min(0).optional(),
  name: z.string().trim().min(1).max(200).optional(),
  mime_type: z.string().max(128).optional(),
});

const linkArtifactSchema = z.object({
  type: z.literal('link'),
  uri: z.string().url().max(2048).refine((value) => /^https?:\/\//i.test(value), '需为 http(s) 外链'),
  name: z.string().trim().min(1).max(200),
});

export const completeSchema = leaseTripleSchema.extend({
  summary: z.string().trim().max(20000).optional(),
  output: z.string().max(65536).optional(),
  artifacts: z
    .array(z.union([uploadedArtifactSchema, linkArtifactSchema]))
    .max(100)
    .default([]),
});
export type CompleteInput = z.infer<typeof completeSchema>;

export const failSchema = leaseTripleSchema.extend({
  error: z.string().trim().min(1).max(20000),
  summary: z.string().max(20000).optional(),
});

export const heartbeatSchema = leaseTripleSchema;

/** 8.4 人工块：Agent 执行到人工块时上报，任务转 BLOCKED 等人工处理。 */
export const blockedSchema = leaseTripleSchema.extend({
  block_id: z.string().trim().min(1).max(64),
  block_title: z.string().max(200).default(''),
  instruction: z.string().trim().min(1).max(2000),
});

/**
 * v0.0.4 W6 §16.1 `wait_for_resume`：长轮询等待 BLOCKED 解除。
 * 不需要三元组：`block_task` 已把租约清空，等待侧只是只读的事件订阅。
 * 超时上限 300 秒（5 分钟）是本地信任模型下 HTTP 长连接与 Agent 端友好度的折中；
 * 更长的等待由 Agent 端循环调用实现。缺省 60 秒覆盖绝大多数「人工点一下」场景。
 */
export const waitForResumeSchema = z.object({
  task_id: idParam,
  timeout_seconds: z.coerce.number().int().min(1).max(300).default(60),
});
export type WaitResumeInput = z.infer<typeof waitForResumeSchema>;

export const reviewFeedbackQuerySchema = z.object({
  task_id: idParam,
  limit: z.coerce.number().int().min(1).max(50).default(5),
});

/** v0.0.4 W6 §16.1 技能工具与策略工具里的技能 ID（`skl_` + uuidv7，最长 40，不放 idLike 的 24）。 */
export const skillIdParam = z.string().trim().min(1).max(64);

/**
 * §12.4/§12.6 `check_mcp_policy`：Agent 调第三方 MCP 前请求本地策略裁决。
 * 依据是被检技能当前声明的 `mcp_dependencies`（策略包随技能下发）：
 * 服务器未声明即拒（deny_undeclared），工具必须精确到工具级（§12.2）。
 * task_id / run_id 可选，只进审计（§12.6 的「调用发起」三要素），不做存在性校验——
 * 策略裁决先于 Run 生命周期的场景（技能调试）也要能查。
 */
export const checkMcpPolicySchema = z.object({
  skill_id: skillIdParam,
  server: z.string().trim().min(1).max(100),
  tool: z.string().trim().min(1).max(100),
  task_id: idParam.optional(),
  run_id: idParam.optional(),
});
export type CheckMcpPolicyInput = z.infer<typeof checkMcpPolicySchema>;

/**
 * §12.6 `report_mcp_call`：调用后回传结果，与 check 的决策记录合起来构成 MCP 审计数据源。
 * 本地信任模型下的尽力上报：字段宽松、只落审计，不做外键校验。
 */
export const reportMcpCallSchema = z.object({
  skill_id: skillIdParam.optional(),
  task_id: idParam.optional(),
  run_id: idParam.optional(),
  server: z.string().trim().min(1).max(100),
  url: z.string().trim().max(2048).optional(),
  tool: z.string().trim().min(1).max(100),
  success: z.boolean(),
  duration_ms: z.number().int().min(0).max(86_400_000).optional(),
  error: z.string().max(2000).optional(),
  /** 调用前是否拿到过策略裁决：allow/deny/unchecked 三态进审计。 */
  policy_decision: z.enum(['allow', 'deny', 'unchecked']).default('unchecked'),
});
export type ReportMcpCallInput = z.infer<typeof reportMcpCallSchema>;

/**
 * v0.0.4 W7 §7.2/§7.5：拆解 board.* 工具面（begin / report_progress / report_task_draft /
 * finish / cancel）。session_id 是 begin 返回的 UUIDv7，工具侧一律按 uuid 收；
 * report_task_draft 的 skill_ids 允许填技能名（§7.5 r3 闭环：finish 时统一解析成 id）。
 */
const breakdownSessionId = z.string().uuid();

export const breakdownBeginSchema = z.object({
  requirement_text: z.string().trim().min(1).max(20000),
  group_id: idParam.optional().nullable(),
  parent_title: z.string().trim().min(1).max(200),
  parent_description: z.string().trim().max(20000).optional().nullable(),
  estimated_tasks: z.number().int().min(1).max(100).optional().nullable(),
  agent_name: z.string().trim().max(100).optional().nullable(),
  skill_used: z.string().trim().max(200).optional().nullable(),
});
export type BreakdownBeginToolInput = z.infer<typeof breakdownBeginSchema>;

export const breakdownProgressReportSchema = z.object({
  session_id: breakdownSessionId,
  step: z.number().int().min(1).max(1000),
  total: z.number().int().min(1).max(1000),
  message: z.string().trim().max(500).optional().nullable(),
});
export type BreakdownProgressReportInput = z.infer<typeof breakdownProgressReportSchema>;

export const breakdownDraftReportSchema = z.object({
  session_id: breakdownSessionId,
  ref: z.string().trim().min(1).max(32),
  title: z.string().trim().min(1).max(200),
  description: z.string().max(20000).optional().nullable(),
  priority: z.number().int().min(0).max(3).optional(),
  /** 值可以是技能 id 或技能名（§7.5 解析闭环）。 */
  skill_ids: z.array(z.string().trim().min(1).max(64)).max(20).optional(),
  acceptance: z.array(z.string().trim().min(1).max(2000)).max(20).optional(),
  depends_on: z.array(z.string().trim().min(1).max(32)).max(50).optional(),
  sort_order: z.number().int().min(0).max(9999).optional(),
});
export type BreakdownDraftReportInput = z.infer<typeof breakdownDraftReportSchema>;

/** finish / cancel 同形：只有 session_id。 */
export const breakdownSessionActionSchema = z.object({ session_id: breakdownSessionId });
export type BreakdownSessionActionInput = z.infer<typeof breakdownSessionActionSchema>;

/**
 * v0.0.4 W8 §8.7 `board.create_task` 入参（样例 JSON 的契约化）。
 * session_id 必填：§8.7 闭环语义要求每次 create_task 都在事务内按 session_id
 * upsert `agent_sessions` 并落 `task_creation_logs`，没有会话标识就无处记账。
 * confirmation_mode 按 §8.2 三模式收：direct=直接创建 / light=轻确认 / silent=静默创建；
 * 缺省按「默认轻确认」解析（§8.2 优先级：参数 > 设置 > light，设置键归下一切片）。
 * skills 与 breakdown 草案同口径：可填技能 id 或技能名，服务端按 §7.5 规则解析。
 */
export const createTaskSchema = z.object({
  title: z.string().trim().min(1).max(200),
  description: z.string().max(20000).optional().nullable(),
  group_id: idParam.optional().nullable(),
  type: z.string().trim().min(1).max(16),
  priority: z.number().int().min(0).max(3).default(3),
  tags: z.array(z.string().trim().min(1).max(50)).max(20).default([]),
  skills: z.array(z.string().trim().min(1).max(64)).max(20).default([]),
  session_id: z.string().trim().min(1).max(100),
  agent_name: z.string().trim().max(100).optional().nullable(),
  confirmation_mode: z.enum(['direct', 'light', 'silent']).optional(),
  // §8.7 闭环语义（r3）：light 缺省服务端阻塞等决策（30s + 5s 宽限）；
  // `wait: false` 走异步模式——调用立即返回 request_id，用 board.get_creation_status 轮询。
  wait: z.boolean().optional(),
});
export type CreateTaskToolInput = z.infer<typeof createTaskSchema>;

/**
 * v0.0.4 W8-a3 §8.7：board.create_tasks_batch（批量创建·轻量版）。
 * 会话/Agent 标识/确认模式是批次级（同一次会话发一批），单条载荷只带任务字段；
 * 最多 20 条——批量是轻量路径，不开无上限的口子。
 */
export const createTaskBatchItemSchema = createTaskSchema.omit({
  session_id: true,
  agent_name: true,
  confirmation_mode: true,
  wait: true,
});
export const createTasksBatchSchema = z.object({
  tasks: z.array(createTaskBatchItemSchema).min(1).max(20),
  session_id: z.string().trim().min(1).max(100),
  agent_name: z.string().trim().max(100).optional().nullable(),
  confirmation_mode: z.enum(['direct', 'light', 'silent']).optional(),
  // 批量缺省 wait:false（区别于单条缺省阻塞）：light 逐条即时返回 request_id 供轮询，
  // 避免最坏 N×35s 串行阻塞；wait:true 时逐条走与单条一致的阻塞等决策语义。
  wait: z.boolean().optional(),
});
export type CreateTasksBatchInput = z.infer<typeof createTasksBatchSchema>;

/** v0.0.4 W8-a2 §8.7：board.get_creation_status / board.wait_for_confirmation 共用入参（按请求 id 查/等）。 */
export const creationRequestRefSchema = z.object({
  request_id: z.string().trim().min(1).max(64),
});
export type CreationRequestRefInput = z.infer<typeof creationRequestRefSchema>;

export const listReadyQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(200).default(50),
  capabilities: z.array(capabilitySchema).max(20).default([]),
  task_types: z.array(z.string().trim().min(1).max(16)).default([]),
});
