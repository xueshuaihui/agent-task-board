import { z } from 'zod';

/** 8.1 技能类型词表（迁移 CHECK 同步）。 */
export const SKILL_TYPES = [
  'prompt',
  'steps',
  'flow',
  'script',
  'knowledge',
  'composite',
  'workflow',
] as const;
export type SkillType = (typeof SKILL_TYPES)[number];

export const SKILL_STATUSES = ['DRAFT', 'PUBLISHED', 'ARCHIVED'] as const;
export type SkillStatus = (typeof SKILL_STATUSES)[number];

/** 8.3 块类型：契约（web features/skills types.ts）15 类，与前端 SkillBlockKind 一致。 */
const BLOCK_KINDS = [
  'prompt',
  'step',
  'decision',
  'loop',
  'parallel',
  'tool',
  'knowledge',
  'script',
  'subskill',
  'human',
  'input',
  'output',
  'constraint',
  'error_handler',
  'comment',
] as const;

const blockNextSchema = z.object({
  when: z.string().max(200).default(''),
  to: z.string().min(1).max(64),
});

/**
 * 块 schema 用 looseObject（passthrough）：content 是「内容载荷」而非入参白名单，
 * text 等业务字段必须无损往返（创建/更新/版本发布均落库解析后的对象，strip 会静默丢字段）。
 * 字段清单与前端 apps/web/src/features/skills/types.ts 的 SkillBlock 一一对应。
 */
const blockSchema = z.looseObject({
  id: z.string().min(1).max(64),
  kind: z.enum(BLOCK_KINDS),
  title: z.string().max(200).default(''),
  text: z.string().max(20000).optional(),
  prompt: z.string().max(20000).optional(),
  condition: z.string().max(2000).optional(),
  humanInstruction: z.string().max(2000).optional(),
  next: z.array(blockNextSchema).max(20).optional(),
  steps: z.array(z.string().max(2000)).max(50).optional(),
  // loop 块
  while: z.string().max(2000).optional(),
  // parallel 块
  merge: z.enum(['all', 'any', 'race']).optional(),
  branches: z.array(z.string().max(2000)).max(50).optional(),
  // tool 块
  script: z.string().max(50000).optional(),
  tool: z.string().max(200).optional(),
  server: z.string().max(200).optional(),
  argsTemplate: z.string().max(20000).optional(),
  // subskill 块
  skillRef: z.string().max(64).optional(),
  // input / output 块
  name: z.string().max(200).optional(),
  valueType: z.string().max(100).optional(),
  required: z.boolean().optional(),
  // constraint 块
  rule: z.string().max(20000).optional(),
  // error_handler 块
  onError: z.enum(['abort', 'retry', 'skip', 'fallback', 'continue']).optional(),
  retryCount: z.number().int().min(0).max(100).optional(),
  timeoutMs: z.number().int().min(0).optional(),
  // comment 块
  note: z.string().max(20000).optional(),
});

export const skillContentSchema = z.object({
  blocks: z.array(blockSchema).max(200).default([]),
  entryBlockId: z.string().max(64).nullable().default(null),
});
export type SkillContent = z.infer<typeof skillContentSchema>;

const mcpDependencySchema = z.object({
  server: z.string().min(1).max(100),
  tools: z.array(z.string().min(1).max(100)).max(50).default([]),
  required: z.boolean().default(true),
  reason: z.string().max(500).optional(),
});
export type SkillMcpDependency = z.infer<typeof mcpDependencySchema>;

/**
 * 8.6 测试用例：与技能版本一起版本化（发布时随版本快照）。
 * input/expected 是 passthrough JSON：input 运行时字符串化成模拟运行的输入；
 * expected 是期望描述（自由结构），不参与自动判定，随结果一起回显给 UI 对照。
 */
export const skillTestCaseSchema = z.looseObject({
  id: z.string().trim().min(1).max(64),
  name: z.string().trim().min(1).max(200),
  input: z.unknown().optional(),
  expected: z.unknown().optional(),
});
export type SkillTestCase = z.infer<typeof skillTestCaseSchema>;

export const skillTestCasesSchema = z.array(skillTestCaseSchema).max(50);

export const skillCreateSchema = z.object({
  name: z.string().trim().min(1).max(100),
  type: z.enum(SKILL_TYPES),
  description: z.string().max(2000).default(''),
  tags: z.array(z.string().trim().min(1).max(30)).max(20).default([]),
  content: skillContentSchema
    .default({ blocks: [], entryBlockId: null }),
  test_cases: skillTestCasesSchema.default([]),
  mcp_dependencies: z.array(mcpDependencySchema).max(20).default([]),
});
export type SkillCreateInput = z.infer<typeof skillCreateSchema>;

export const skillPatchSchema = z
  .object({
    name: z.string().trim().min(1).max(100).optional(),
    description: z.string().max(2000).optional(),
    tags: z.array(z.string().trim().min(1).max(30)).max(20).optional(),
    content: skillContentSchema.optional(),
    test_cases: skillTestCasesSchema.optional(),
    status: z.enum(SKILL_STATUSES).optional(),
  })
  .refine((value) => Object.keys(value).length > 0, { message: '没有需要更新的字段' });
export type SkillPatchInput = z.infer<typeof skillPatchSchema>;

export const skillVersionCreateSchema = z.object({
  content: skillContentSchema,
  changelog: z.string().max(500).default(''),
  // 8.6：发布时的测试用例快照；缺省沿用技能当前的 test_cases。
  test_cases: skillTestCasesSchema.optional(),
  mcp_dependencies: z.array(mcpDependencySchema).max(20).optional(),
});
export type SkillVersionCreateInput = z.infer<typeof skillVersionCreateSchema>;

export const skillRollbackSchema = z.object({
  version: z.string().trim().min(1).max(20),
});

export const skillTestSchema = z.object({
  input: z.string().max(20000).default(''),
});

// ---------------------------------------------------------------- 8.8 技能源

export const SKILL_SOURCE_TYPES = ['builtin', 'directory', 'git', 'http'] as const;
export type SkillSourceType = (typeof SKILL_SOURCE_TYPES)[number];

/** git/http 是服务端类型：可存配置，但本期扫描只回 501。 */
export const CLOUD_SOURCE_TYPES: readonly SkillSourceType[] = ['git', 'http'];

export const skillSourceSchema = z.object({
  id: z.string().trim().min(1).max(64),
  type: z.enum(SKILL_SOURCE_TYPES),
  name: z.string().trim().min(1).max(100),
  path: z.string().max(1024).default(''),
  enabled: z.boolean().default(true),
});
export type SkillSource = z.infer<typeof skillSourceSchema>;

export const skillSourcesSchema = z.array(skillSourceSchema).max(20);
export type SkillSourcesInput = z.infer<typeof skillSourcesSchema>;

export const skillSourceScanSchema = z.object({
  source_id: z.string().trim().min(1).max(64),
});

export const skillImportMarkdownSchema = z.object({
  filename: z.string().trim().min(1).max(255),
  content: z.string().min(1).max(1_000_000),
});
export type SkillImportMarkdownInput = z.infer<typeof skillImportMarkdownSchema>;

export const skillListQuerySchema = z.object({
  keyword: z.string().trim().max(100).optional(),
  type: z.enum(SKILL_TYPES).optional(),
  status: z.enum(SKILL_STATUSES).optional(),
  tag: z.string().trim().max(30).optional(),
});
export type SkillListQuery = z.infer<typeof skillListQuerySchema>;

/** 10.3 任务侧绑定引用（PATCH /tasks/:id 的 skills 字段元素）。 */
export const taskSkillRefSchema = z.object({
  skill_id: z.string().min(1).max(64),
  version: z.string().trim().max(20).optional(),
});
export type TaskSkillRef = z.infer<typeof taskSkillRefSchema>;

// ---------------------------------------------------------------- 读取模型

export interface SkillVersionSummary {
  version: string;
  changelog: string;
  created_at: string | null;
  current: boolean;
}

export interface SkillDto {
  id: string;
  name: string;
  type: SkillType;
  status: SkillStatus;
  description: string;
  tags: string[];
  current_version: string;
  content: SkillContent;
  test_cases: SkillTestCase[];
  mcp_dependencies: SkillMcpDependency[];
  created_at: string | null;
  updated_at: string | null;
  versions?: SkillVersionSummary[];
  stats?: { bound_task_count: number };
}

/** 8.6 测试运行：无用例时单次运行（旧形态 + mode），有用例时逐个运行。 */
export interface SkillTestSingle {
  mode: 'single';
  ok: boolean;
  logs: string[];
  output: string;
  blocked?: { blockId: string; instruction: string };
}

export interface SkillTestCaseResult {
  case_id: string;
  name: string;
  ok: boolean;
  logs: string[];
  output: string;
}

export interface SkillTestCases {
  mode: 'cases';
  results: SkillTestCaseResult[];
  passed: number;
  total: number;
}

export type SkillTestResult = SkillTestSingle | SkillTestCases;

/** Agent 下发（10.3）：绑定引用 + 内容 + 版本 + MCP 依赖一起给。 */
export interface TaskSkillPayload {
  skill_id: string;
  version: string;
  name: string;
  type: SkillType;
  status: SkillStatus;
  content: SkillContent;
  mcp_dependencies: SkillMcpDependency[];
}

export function parseJson<T>(raw: string | null | undefined, fallback: T): T {
  if (!raw) return fallback;
  try {
    const value: unknown = JSON.parse(raw);
    return value as T;
  } catch {
    return fallback;
  }
}

/** tasks.skills 列 → 绑定引用数组（坏 JSON / 非数组一律空，读路径不炸）。 */
export function parseSkillRefs(raw: string | null | undefined): TaskSkillRef[] {
  const refs = parseJson<unknown>(raw, []);
  if (!Array.isArray(refs)) return [];
  return refs.filter(
    (ref): ref is TaskSkillRef =>
      !!ref && typeof ref === 'object' && typeof (ref as TaskSkillRef).skill_id === 'string',
  );
}

/** 8.4 版本号自增：vMAJOR.MINOR.PATCH 的 PATCH 段 +1；解析不了就回 v0.1.0 语义外再兜 v0.1.1。 */
export function nextPatchVersion(current: string): string {
  const match = /^v?(\d+)\.(\d+)\.(\d+)$/.exec(current);
  if (!match) return 'v0.1.0';
  return `v${match[1]}.${match[2]}.${Number(match[3]) + 1}`;
}
