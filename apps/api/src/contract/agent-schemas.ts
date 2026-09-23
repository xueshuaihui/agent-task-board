import { z } from 'zod';
import { AGENT_CONFIRMATION_MODES, ARTIFACT_TYPES, DEFAULT_TASK_TYPES } from './enums';
import { capabilitySchema, idLike } from './schemas';
import {
  ARTIFACT_TYPE_DESC,
  CAPABILITIES_ARRAY_DESC,
  CONFIRMATION_MODE_DESC,
  CREATE_TASK_TYPE_DESC,
  LOG_LEVELS,
  PRIORITY_FIELD_DESC,
  TASK_TYPE_FILTER_DESC,
} from './vocabulary';

const idParam = idLike;

/** 12 章通用契约：除三个只读工具外，写回入参必须带 task_id + run_id + lease_id 三元组。 */
export const leaseTripleSchema = z.object({
  task_id: idParam.describe('任务 ID（如 T-1024 或 task_ 前缀主键），必须已存在且被本 Run 锁定'),
  run_id: idParam.describe('Run ID（run_ 前缀），来自 claim_next_task 返回的 lease.run_id'),
  lease_id: z
    .string()
    .uuid()
    .describe('租约 ID（UUID），来自 claim_next_task 返回的 lease.lease_id；三元组任一不匹配回 409'),
});

export const claimSchema = z.object({
  capabilities: z
    .array(capabilitySchema)
    .max(20)
    .default([])
    .describe(CAPABILITIES_ARRAY_DESC),
  task_types: z
    .array(z.string().trim().min(1).max(16))
    .default([])
    .describe(TASK_TYPE_FILTER_DESC),
});
export type ClaimInput = z.infer<typeof claimSchema>;

export const progressSchema = leaseTripleSchema.extend({
  progress: z
    .number()
    .int()
    .min(0)
    .max(100)
    .describe('进度百分比，0-100 整数；服务端只单调不回退'),
  message: z.string().trim().max(500).optional().describe('一句话进度说明，展示在执行流；可省'),
});

export const appendLogSchema = leaseTripleSchema.extend({
  /** 单次调用的行数；单 Run 累计上限 5000 行（20.8），超限由服务端做首尾保留截断。 */
  lines: z
    .array(z.string().max(4000))
    .min(1)
    .max(500)
    .describe('日志行数组：单次 1-500 行、单行 ≤4000 字符；单 Run 累计上限 5000 行，超限服务端首尾保留截断（20.8）'),
  level: z
    .enum(LOG_LEVELS)
    .default('info')
    .describe(`日志级别，取值：${LOG_LEVELS.join('/')}；缺省 info`),
});

/** 20.6：普通产物引用的是先上传后返回的相对路径；`link` 例外，uri 就是 http(s) 外链。 */
const uploadedArtifactSchema = z.object({
  type: z
    .enum(ARTIFACT_TYPES)
    .exclude(['link'])
    .describe(`产物类型，取值：${ARTIFACT_TYPES.filter((t) => t !== 'link').join('/')}；uri 必须是上传接口返回的相对路径`),
  uri: z
    .string()
    .min(1)
    .max(1024)
    .refine(
      (value) => !value.startsWith('/') && !value.includes('\\') && !value.split('/').includes('..'),
      'uri 需为上传接口返回的相对路径',
    )
    .describe('上传接口（POST /artifacts/upload）返回的相对路径；不以 / 开头、不含 ..；不要凭空拼 URL'),
  size_bytes: z.number().int().min(0).optional().describe('文件字节数，上传接口返回值透传；可省'),
  name: z.string().trim().min(1).max(200).optional().describe('产物展示名；可省，缺省用上传返回的文件名'),
  mime_type: z.string().max(128).optional().describe('MIME 类型（如 text/markdown）；可省'),
});

const linkArtifactSchema = z.object({
  type: z.literal('link').describe('产物类型，固定 link：uri 直接是 http(s) 外链，无需上传'),
  uri: z
    .string()
    .url()
    .max(2048)
    .refine((value) => /^https?:\/\//i.test(value), '需为 http(s) 外链')
    .describe('http(s):// 开头的外链 URL（PRD 链接、CI 报告等）'),
  name: z.string().trim().min(1).max(200).describe('链接展示名，link 类型必填（1-200 字符）'),
});

export const completeSchema = leaseTripleSchema.extend({
  summary: z
    .string()
    .trim()
    .max(20000)
    .optional()
    .describe('完成摘要（≤20000 字符），进审核页展示；可省，建议写'),
  output: z.string().max(65536).optional().describe('结构化最终输出（≤65536 字符），如 JSON 文本；可省'),
  artifacts: z
    .array(z.union([uploadedArtifactSchema, linkArtifactSchema]))
    .max(100)
    .default([])
    .describe(`产物引用数组（≤100 个），元素二选一：${ARTIFACT_TYPE_DESC}；空数组=无产物`),
});
export type CompleteInput = z.infer<typeof completeSchema>;

export const failSchema = leaseTripleSchema.extend({
  error: z
    .string()
    .trim()
    .min(1)
    .max(20000)
    .describe('失败原因（1-20000 字符），必填；写清出错环节与原始报错，供审核页与审计回显'),
  summary: z.string().max(20000).optional().describe('失败摘要补充；可省'),
});

export const heartbeatSchema = leaseTripleSchema;

/** 8.4 人工块：Agent 执行到人工块时上报，任务转 BLOCKED 等人工处理。 */
export const blockedSchema = leaseTripleSchema.extend({
  block_id: z
    .string()
    .trim()
    .min(1)
    .max(64)
    .describe('人工块标识（技能定义中 human 块的 id），同一 Run 内唯一；人工处理后经 wait_for_resume 感知'),
  block_title: z.string().max(200).default('').describe('人工块标题，展示在阻塞卡片；缺省空串'),
  instruction: z
    .string()
    .trim()
    .min(1)
    .max(2000)
    .describe('需要人工做什么的指令文本（1-2000 字符），必填；写具体动作，不要只写「需要人工」'),
});

/**
 * v0.0.4 W6 §16.1 `wait_for_resume`：长轮询等待 BLOCKED 解除。
 * 不需要三元组：`block_task` 已把租约清空，等待侧只是只读的事件订阅。
 * 超时上限 300 秒（5 分钟）是本地信任模型下 HTTP 长连接与 Agent 端友好度的折中；
 * 更长的等待由 Agent 端循环调用实现。缺省 60 秒覆盖绝大多数「人工点一下」场景。
 */
export const waitForResumeSchema = z.object({
  task_id: idParam.describe('任务 ID：等待其从 BLOCKED 转回其它状态（人工处理后由界面触发）'),
  timeout_seconds: z
    .coerce
    .number()
    .int()
    .min(1)
    .max(300)
    .default(60)
    .describe('长轮询超时秒数，1-300，缺省 60；超时不算错误，返回 timed_out:true，需自行续等'),
});
export type WaitResumeInput = z.infer<typeof waitForResumeSchema>;

export const reviewFeedbackQuerySchema = z.object({
  task_id: idParam.describe('任务 ID：读取该任务最近的审核意见（含驳回理由）'),
  limit: z.coerce
    .number()
    .int()
    .min(1)
    .max(50)
    .default(5)
    .describe('返回条数，1-50，缺省 5'),
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
  skill_id: skillIdParam.describe('被检技能 ID（skl_ 前缀）：策略依据是该技能当前声明的 mcp_dependencies'),
  server: z
    .string()
    .trim()
    .min(1)
    .max(100)
    .describe('第三方 MCP 服务器名（1-100 字符），必须已在技能的 mcp_dependencies 中声明，未声明即拒'),
  tool: z
    .string()
    .trim()
    .min(1)
    .max(100)
    .describe('要调用的工具名（1-100 字符），策略精确到工具级（§12.2），只声明服务器不声明工具同样拒'),
  task_id: idParam.optional().describe('关联任务 ID；可选，仅进审计，不做存在性校验'),
  run_id: idParam.optional().describe('关联 Run ID；可选，仅进审计，不做存在性校验'),
});
export type CheckMcpPolicyInput = z.infer<typeof checkMcpPolicySchema>;

/**
 * §12.6 `report_mcp_call`：调用后回传结果，与 check 的决策记录合起来构成 MCP 审计数据源。
 * 本地信任模型下的尽力上报：字段宽松、只落审计，不做外键校验。
 */
export const reportMcpCallSchema = z.object({
  skill_id: skillIdParam.optional().describe('发起调用的技能 ID；可选，仅进审计'),
  task_id: idParam.optional().describe('关联任务 ID；可选，仅进审计'),
  run_id: idParam.optional().describe('关联 Run ID；可选，仅进审计'),
  server: z.string().trim().min(1).max(100).describe('被调用的 MCP 服务器名（1-100 字符），必填'),
  url: z.string().trim().max(2048).optional().describe('服务器地址；可选，仅进审计'),
  tool: z.string().trim().min(1).max(100).describe('实际调用的工具名（1-100 字符），必填'),
  success: z.boolean().describe('本次调用是否成功（布尔），必填'),
  duration_ms: z
    .number()
    .int()
    .min(0)
    .max(86_400_000)
    .optional()
    .describe('调用耗时毫秒（0-86400000）；可选'),
  error: z.string().max(2000).optional().describe('失败原因（≤2000 字符）；success:false 时建议填'),
  /** 调用前是否拿到过策略裁决：allow/deny/unchecked 三态进审计。 */
  policy_decision: z
    .enum(['allow', 'deny', 'unchecked'])
    .default('unchecked')
    .describe('调用前 check_mcp_policy 的裁决：allow/deny/unchecked 三态，缺省 unchecked（只进审计）'),
});
export type ReportMcpCallInput = z.infer<typeof reportMcpCallSchema>;

/**
 * v0.0.4 W7 §7.2/§7.5：拆解 board.* 工具面（begin / report_progress / report_task_draft /
 * finish / cancel）。session_id 是 begin 返回的 UUIDv7，工具侧一律按 uuid 收；
 * report_task_draft 的 skill_ids 允许填技能名（§7.5 r3 闭环：finish 时统一解析成 id）。
 */
const breakdownSessionId = z.string().uuid();

export const breakdownBeginSchema = z.object({
  requirement_text: z
    .string()
    .trim()
    .min(1)
    .max(20000)
    .describe('原始需求文本（1-20000 字符），必填；拆解会话围绕它展开'),
  group_id: idParam.optional().nullable().describe('归属分组 ID（grp_ 前缀）；缺省进「默认」分组（grp_default）'),
  parent_title: z
    .string()
    .trim()
    .min(1)
    .max(200)
    .describe('父任务标题（1-200 字符），必填；确认页与创建出的子任务都挂在它下面'),
  parent_description: z.string().trim().max(20000).optional().nullable().describe('父任务描述；可省'),
  estimated_tasks: z
    .number()
    .int()
    .min(1)
    .max(100)
    .optional()
    .nullable()
    .describe('预估拆解出的任务数（1-100），用于进度条 total 展示；可省'),
  agent_name: z
    .string()
    .trim()
    .max(100)
    .optional()
    .nullable()
    .describe('发起拆解的 Agent 展示名；缺省取本次 Token 凭证名（确认页据此渲染）'),
  skill_used: z.string().trim().max(200).optional().nullable().describe('本次拆解使用的技能名/ID；可省，仅进会话记录'),
});
export type BreakdownBeginToolInput = z.infer<typeof breakdownBeginSchema>;

export const breakdownProgressReportSchema = z.object({
  session_id: breakdownSessionId.describe('拆解会话 ID（begin_breakdown 返回的 UUID）；会话须处于 receiving'),
  step: z.number().int().min(1).max(1000).describe('当前进度步（1-1000），须 ≤ total'),
  total: z.number().int().min(1).max(1000).describe('总步数（1-1000）'),
  message: z.string().trim().max(500).optional().nullable().describe('本步说明文本（≤500 字符）；可省'),
});
export type BreakdownProgressReportInput = z.infer<typeof breakdownProgressReportSchema>;

export const breakdownDraftReportSchema = z.object({
  session_id: breakdownSessionId.describe('拆解会话 ID（begin_breakdown 返回的 UUID）'),
  ref: z
    .string()
    .trim()
    .min(1)
    .max(32)
    .describe('草案内的临时引用号（如 t1/t2），会话内唯一；同 ref 重报即覆盖，depends_on 用它连依赖'),
  title: z.string().trim().min(1).max(200).describe('子任务标题（1-200 字符），必填'),
  description: z.string().max(20000).optional().nullable().describe('子任务描述（≤20000 字符）；可省'),
  priority: z
    .number()
    .int()
    .min(0)
    .max(3)
    .optional()
    .describe(PRIORITY_FIELD_DESC),
  /** 值可以是技能 id 或技能名（§7.5 解析闭环）。 */
  skill_ids: z
    .array(z.string().trim().min(1).max(64))
    .max(20)
    .optional()
    .describe('绑定技能数组（≤20 个）：可填技能 ID（skl_ 前缀）或技能名，finish_breakdown 时统一解析成 ID（§7.5）；解析不到的进告警不阻断'),
  acceptance: z
    .array(z.string().trim().min(1).max(2000))
    .max(20)
    .optional()
    .describe('验收标准条目数组（≤20 条、单条 ≤2000 字符）；可省，建议写'),
  depends_on: z
    .array(z.string().trim().min(1).max(32))
    .max(50)
    .optional()
    .describe('依赖的其它草案 ref 数组（≤50 个），只填本会话内已上报的 ref；成环在 finish_breakdown 时拒绝'),
  sort_order: z
    .number()
    .int()
    .min(0)
    .max(9999)
    .optional()
    .describe('确认页排序序号（0-9999），小的在前；可省'),
});
export type BreakdownDraftReportInput = z.infer<typeof breakdownDraftReportSchema>;

/** finish / cancel 同形：只有 session_id。 */
export const breakdownSessionActionSchema = z.object({
  session_id: breakdownSessionId.describe(
    '拆解会话 ID（begin_breakdown 返回的 UUID）；finish 要求 receiving、cancel 允许 receiving/reviewing',
  ),
});
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
  title: z.string().trim().min(1).max(200).describe('任务标题（1-200 字符），必填；一个任务说一件事'),
  description: z
    .string()
    .max(20000)
    .optional()
    .nullable()
    .describe('任务描述（≤20000 字符）：背景、验收标准、相关文件路径；可省，建议写'),
  group_id: idParam.optional().nullable().describe('归属分组 ID（grp_ 前缀）；缺省进「默认」分组（grp_default）'),
  type: z.string().trim().min(1).max(16).describe(CREATE_TASK_TYPE_DESC),
  priority: z
    .number()
    .int()
    .min(0)
    .max(3)
    .default(3)
    .describe(PRIORITY_FIELD_DESC),
  tags: z
    .array(z.string().trim().min(1).max(50))
    .max(20)
    .default([])
    .describe('标签数组（≤20 个、单个 ≤50 字符），自由文本、服务端去重；不需要与任何词表对齐'),
  skills: z
    .array(z.string().trim().min(1).max(64))
    .max(20)
    .default([])
    .describe('绑定技能数组（≤20 个）：可填技能 ID（skl_ 前缀）或技能名，服务端按 §7.5 规则解析；不确定取值用 list_skills/search_skills 查'),
  session_id: z
    .string()
    .trim()
    .min(1)
    .max(100)
    .describe('会话标识（1-100 字符，如客户端的 conversation id），必填：服务端据此 upsert agent_sessions 并落创建流水'),
  agent_name: z
    .string()
    .trim()
    .max(100)
    .optional()
    .nullable()
    .describe('Agent 展示名；缺省取本次 Token 凭证名（来源列与流水据此记账）'),
  confirmation_mode: z
    .enum(AGENT_CONFIRMATION_MODES)
    .optional()
    .describe(CONFIRMATION_MODE_DESC),
  // §8.7 闭环语义（r3）：light 缺省服务端阻塞等决策（30s + 5s 宽限）；
  // `wait: false` 走异步模式——调用立即返回 request_id，用 board.get_creation_status 轮询。
  wait: z
    .boolean()
    .optional()
    .describe(
      'light 模式是否阻塞等决策：缺省 true（阻塞至确认/取消/超时）；false 立即返回 request_id，改用 board.get_creation_status / board.wait_for_confirmation 收口。direct/silent 忽略本参数',
    ),
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
  tasks: z
    .array(createTaskBatchItemSchema)
    .min(1)
    .max(20)
    .describe('任务载荷数组（1-20 条），字段口径与 board.create_task 单条一致；串行逐条落库，单条失败不熔断整批'),
  session_id: z
    .string()
    .trim()
    .min(1)
    .max(100)
    .describe('批次共用的会话标识（1-100 字符），必填；整批按同一 session upsert agent_sessions'),
  agent_name: z
    .string()
    .trim()
    .max(100)
    .optional()
    .nullable()
    .describe('批次共用的 Agent 展示名；缺省取本次 Token 凭证名'),
  confirmation_mode: z
    .enum(AGENT_CONFIRMATION_MODES)
    .optional()
    .describe(CONFIRMATION_MODE_DESC + '；批次级生效'),
  // 批量缺省 wait:false（区别于单条缺省阻塞）：light 逐条即时返回 request_id 供轮询，
  // 避免最坏 N×35s 串行阻塞；wait:true 时逐条走与单条一致的阻塞等决策语义。
  wait: z
    .boolean()
    .optional()
    .describe(
      '是否逐条阻塞等轻确认：批量缺省 false（light 条目即时返回 request_id 供轮询，避免最坏 N×35s 串行阻塞）；true 时逐条走与单条一致的阻塞语义',
    ),
});
export type CreateTasksBatchInput = z.infer<typeof createTasksBatchSchema>;

/** v0.0.4 W8-a2 §8.7：board.get_creation_status / board.wait_for_confirmation 共用入参（按请求 id 查/等）。 */
export const creationRequestRefSchema = z.object({
  request_id: z
    .string()
    .trim()
    .min(1)
    .max(64)
    .describe('创建请求 ID（1-64 字符），来自 board.create_task(-batch) light+wait:false 返回的 request_id'),
});
export type CreationRequestRefInput = z.infer<typeof creationRequestRefSchema>;

export const listReadyQuerySchema = z.object({
  limit: z.coerce
    .number()
    .int()
    .min(1)
    .max(200)
    .default(50)
    .describe('最多返回条数，1-200，缺省 50'),
  capabilities: z
    .array(capabilitySchema)
    .max(20)
    .default([])
    .describe(CAPABILITIES_ARRAY_DESC),
  task_types: z
    .array(z.string().trim().min(1).max(16))
    .default([])
    .describe(`${TASK_TYPE_FILTER_DESC}默认词表外的自定义类型同样按全等匹配，词表可用 get_vocabulary 查询；缺省词表：${DEFAULT_TASK_TYPES.join('/')}`),
});
