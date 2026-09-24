import { z } from 'zod';
import {
  AGENT_CONFIRMATION_MODES,
  ARTIFACT_TYPES,
  DEFAULT_TASK_TYPES,
  TAG_MAX_LENGTH,
  TAGS_MAX_PER_TASK,
} from './enums';
import { capabilitySchema, idLike, taskPatchSchema, type TaskPatchInput } from './schemas';
import { skillPatchSchema, type SkillPatchInput } from '../skills/skills.dto';
import {
  ARTIFACT_TYPE_DESC,
  CAPABILITIES_ARRAY_DESC,
  CONFIRMATION_MODE_DESC,
  CREATE_TASK_TYPE_DESC,
  LOG_LEVELS,
  PRIORITY_FIELD_DESC,
  PRIORITY_LEVELS_TEXT,
  SKILL_CATEGORY_DESC,
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

/**
 * v0.0.4 §16.1 `update_task`：任务全字段 PATCH 的 Agent 面。
 *
 * 可写字段**逐字取 REST 的 `taskPatchSchema.shape`**（同一批 zod 实例，不抄第二套校验；
 * 词表/技能/父子/分组这些字段级规则全部留在 `TasksService` 的 `applyPatch` 那一处实现里，
 * UI 与 Agent 共用）。
 * `.describe()` 只是给 tools/list 下发口径用的包装（zod 返回新实例，不污染 UI 侧那份）。
 *
 * 越权面：`status` / `assignee` 这些状态机与执行权列根本不在 shape 里，本工具改不到：
 * MCP 协议层会先按 inputSchema 把未声明键剥掉（只提交越权键时命中下面的 refine，
 * 报「没有需要更新的字段」），非 HTTP 直连通道才由 `.strict()` 报 422 `unrecognized_keys`。
 * `run_id` / `lease_id` 是**选填**：BACKLOG/READY 还没被认领、没有租约可带；RUNNING 必须带，
 * 缺了由 `WritebackService.updateTask` 拒掉并在错误里点名要带什么（与 update_progress 同口径的
 * `leases.verify`，租约不匹配/过期/被吊销沿用既有的 410 语义，不另造规则）。
 */
const patchField = <K extends keyof typeof taskPatchSchema.shape>(key: K, desc: string) =>
  taskPatchSchema.shape[key].describe(desc);

/** 可写字段名单：从 shape 派生，不手抄第二份，避免与 REST 的 patch 面漂移。 */
export const TASK_PATCH_FIELDS = Object.keys(taskPatchSchema.shape) as (keyof TaskPatchInput & string)[];

export const updateTaskSchema = z
  .object({
    task_id: idParam.describe(
      '要编辑的任务 ID（如 T-1024 或 task_ 前缀主键）；RUNNING 必须带当前租约三元组，BACKLOG/READY 免租约，其余状态会被拒',
    ),
    run_id: idParam
      .optional()
      .describe('Run ID（claim_next_task 返回的 lease.run_id）：任务处于 RUNNING 时必填，用于租约校验；未认领任务可省'),
    lease_id: z
      .string()
      .uuid()
      .optional()
      .describe('租约 ID（UUID，claim_next_task 返回的 lease.lease_id）：任务处于 RUNNING 时必填；未认领任务可省'),
    title: patchField('title', '任务标题（1-200 字符，首尾空白自动去掉）；只改提交的字段，未提交的保持原样'),
    type: patchField(
      'type',
      `任务类型，必须命中服务端生效词表（否则 422 并在 details 里回显「可选：…」全量词表）。默认词表：${DEFAULT_TASK_TYPES.join('/')}，自定义类型由设置项 task_types 扩充（先调 get_vocabulary 拿口径，不要试错）。改类型会按新类型重校验 custom_fields 的适用性`,
    ),
    priority: patchField('priority', `优先级，整数：${PRIORITY_LEVELS_TEXT}；数字越小越紧急。表外值 422`),
    description: patchField('description', '任务描述（≤20000 字符）；传 null 清空描述'),
    tags: patchField(
      'tags',
      `标签数组（≤${TAGS_MAX_PER_TASK} 个、单个 ≤${TAG_MAX_LENGTH} 字符，服务端去重）；**整体覆盖**现有标签，不是追加`,
    ),
    required_capabilities: patchField('required_capabilities', CAPABILITIES_ARRAY_DESC + '；整体覆盖写入，影响后续可认领性，格式非法 422'),
    custom_fields: patchField(
      'custom_fields',
      '自定义字段键值对象，增量合并进现有值；键必须已在字段定义里登记且适用于当前类型，值需符合该字段类型，否则 422 逐键回显原因',
    ),
    due_at: patchField('due_at', '到期日：YYYY-MM-DD 或 ISO 时间（服务端归一为日期）；传 null 清空到期日'),
    pinned: patchField('pinned', '是否置顶（布尔）'),
    group_id: patchField(
      'group_id',
      '归属分组 ID（UUID，≤64 字符），跨组移动用它；传 null 表示移出分组到未分配。目标分组已归档回 409 GROUP_ARCHIVED',
    ),
    parent_task_id: patchField(
      'parent_task_id',
      '父需求任务 ID；传 null 脱离父需求。父必须是「需求」类型且自身不是子任务（层级最多两层），本任务已有子任务时也不能再挂上去，否则 422',
    ),
    sort_order: patchField('sort_order', '同列/同需求内的手动排序序号（整数，越小越前），拖拽排序的落库值'),
    skills: patchField(
      'skills',
      '绑定的技能引用数组（≤20）：[{skill_id, version?}]，version 缺省取该技能当前版本；**整体覆盖**现有绑定；技能或版本不存在时 422，details 指名是哪个引用（可先用 list_skills 查可用技能与版本，不要试错）',
    ),
  })
  .strict()
  .refine((value) => TASK_PATCH_FIELDS.some((field) => value[field] !== undefined), {
    message: '没有需要更新的字段：至少提交一个可写字段（title / type / priority / tags / skills …）',
  });
export type UpdateTaskInput = z.infer<typeof updateTaskSchema>;

/** 从 `update_task` 入参里挑出可写的那部分，交给 TasksService 的同一份 patch 写入逻辑。 */
export function taskPatchFromUpdateInput(input: UpdateTaskInput): TaskPatchInput {
  const patch: Record<string, unknown> = {};
  for (const field of TASK_PATCH_FIELDS) {
    if (input[field] !== undefined) patch[field] = input[field];
  }
  return patch as TaskPatchInput;
}

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
 * v0.0.4 §16.1 `update_skill`：技能全字段 PATCH 的 Agent 面（与 `update_task` 同一个形状）。
 *
 * 可写字段**逐字取 REST 的 `skillPatchSchema.shape`**（同一批 zod 实例，不抄第二套校验；
 * 只读守卫、分类越表、子技能引用环这些规则全部留在 `SkillsService.patch` 那一处实现里，
 * UI 与 Agent 共用）。`.describe()` 只是给 tools/list 下发口径用的包装（zod 返回新实例，
 * 不污染 UI 侧那份）。
 *
 * 两处**明确不可写**，理由不同：
 *  - `status`：UI 的「发布」是两步——`POST /skills/:id/versions`（服务端自增 semver 并置
 *    current_version）**加上** `PATCH {status:'PUBLISHED'}`（`apps/web/src/features/skills/hooks.ts:102`）。
 *    agent 面没有版本快照工具，只给 `status` 就等于允许把**没有快照**的内容标成已发布，
 *    `current_version` 与 content 从此脱节。所以本工具不收 `status`：发布/归档不在 agent 面，
 *    需要发布由人在 UI 走版本快照。越权传 `status` 的通道语义与 `update_task` 同一口径——
 *    MCP 协议层（SDK 按 inputSchema 先 `z.object(shape)` 校验）会把未声明键**剥掉**，
 *    只提交越权键时命中下面的 refine（报「没有需要更新的字段」）；脱离 HTTP 的直接调用
 *    （脚本/诊断走 `callAgentTool`）才由 `.strict()` 报 422 `unrecognized_keys`。
 *  - `mcp_dependencies`：REST 的 `skillPatchSchema` 里也没有它（只在 create 与版本创建里出现），
 *    UI 同样改不了；本工具与 UI 的 PATCH 面保持一致，不另开口子。
 */
const skillPatchField = <K extends keyof typeof skillPatchSchema.shape>(key: K, desc: string) =>
  skillPatchSchema.shape[key].describe(desc);

/**
 * 可写字段名单：从 REST 的 shape 派生后**减去 `status`**，不手抄第二份，避免与 UI 的 patch 面漂移
 * （漂移的两种方向都不许发生：UI 有的字段 agent 少收、UI 没有的字段 agent 多收）。
 */
export const SKILL_PATCH_FIELDS = (
  Object.keys(skillPatchSchema.shape) as (keyof SkillPatchInput & string)[]
).filter((field) => field !== 'status');

export const updateSkillSchema = z
  .object({
    skill_id: skillIdParam.describe(
      '要编辑的技能 ID（skl_ 前缀），来自 list_skills/get_skill/search_skills；内置默认技能（source=default，随应用包更新的那批）不可编辑，回 SKILL_READONLY',
    ),
    name: skillPatchField('name', '技能名称（1-100 字符，首尾空白自动去掉）；允许与其它技能重名，改名不查重'),
    description: skillPatchField('description', '技能描述（≤2000 字符）；只改提交了的字段，未提交的保持原样'),
    category: skillPatchField('category', SKILL_CATEGORY_DESC),
    tags: skillPatchField(
      'tags',
      '自由标签数组（≤20 个、单个 1-30 字符）；**整体覆盖**现有标签，不是追加。标签与分类互不推导',
    ),
    content: skillPatchField(
      'content',
      '技能正文，结构化块模型 `{ blocks, entryBlockId }`（块类型见 get_vocabulary 的 skill.types）。本字段是**整体覆盖**：请先 `get_skill` 拿当前 content，在其上改要动的块后整份回提，只给片段会把其余块清空。块里的 `subskill` 块用 `skillRef` 引用其它技能：引用自身回 SKILL_REF_SELF、经其它技能成环回 SKILL_REF_CYCLE（details.chain 给出环路径）',
    ),
    test_cases: skillPatchField(
      'test_cases',
      '测试用例数组（≤50 条），元素 `{ id, name, input?, expected? }`；**整体覆盖**，不是追加。发布时随版本快照，本接口只写当前草稿',
    ),
  })
  .strict()
  .refine((value) => SKILL_PATCH_FIELDS.some((field) => value[field] !== undefined), {
    message: '没有需要更新的字段：至少提交一个可写字段（name / description / category / tags / content / test_cases）',
  });
export type UpdateSkillInput = z.infer<typeof updateSkillSchema>;

/** 从 `update_skill` 入参里挑出可写的那部分，交给 SkillsService 的同一份 patch 写入逻辑。 */
export function skillPatchFromUpdateInput(input: UpdateSkillInput): SkillPatchInput {
  const patch: Record<string, unknown> = {};
  for (const field of SKILL_PATCH_FIELDS) {
    if (input[field] !== undefined) patch[field] = input[field];
  }
  return patch as SkillPatchInput;
}

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
