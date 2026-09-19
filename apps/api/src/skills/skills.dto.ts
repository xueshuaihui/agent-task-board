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

/** 8.3 块类型：契约（web features/skills types.ts）七种。 */
const blockNextSchema = z.object({
  when: z.string().max(200).default(''),
  to: z.string().min(1).max(64),
});

/**
 * 块 schema 用 looseObject（passthrough）：content 是「内容载荷」而非入参白名单，
 * text 等业务字段必须无损往返（创建/更新/版本发布均落库解析后的对象，strip 会静默丢字段）。
 */
const blockSchema = z.looseObject({
  id: z.string().min(1).max(64),
  kind: z.enum(['prompt', 'step', 'decision', 'script', 'knowledge', 'human', 'tool']),
  title: z.string().max(200).default(''),
  text: z.string().max(20000).optional(),
  prompt: z.string().max(20000).optional(),
  condition: z.string().max(2000).optional(),
  humanInstruction: z.string().max(2000).optional(),
  next: z.array(blockNextSchema).max(20).optional(),
  steps: z.array(z.string().max(2000)).max(50).optional(),
  script: z.string().max(50000).optional(),
  tool: z.string().max(200).optional(),
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

export const skillCreateSchema = z.object({
  name: z.string().trim().min(1).max(100),
  type: z.enum(SKILL_TYPES),
  description: z.string().max(2000).default(''),
  tags: z.array(z.string().trim().min(1).max(30)).max(20).default([]),
  content: skillContentSchema
    .default({ blocks: [], entryBlockId: null }),
  mcp_dependencies: z.array(mcpDependencySchema).max(20).default([]),
});
export type SkillCreateInput = z.infer<typeof skillCreateSchema>;

export const skillPatchSchema = z
  .object({
    name: z.string().trim().min(1).max(100).optional(),
    description: z.string().max(2000).optional(),
    tags: z.array(z.string().trim().min(1).max(30)).max(20).optional(),
    content: skillContentSchema.optional(),
    status: z.enum(SKILL_STATUSES).optional(),
  })
  .refine((value) => Object.keys(value).length > 0, { message: '没有需要更新的字段' });
export type SkillPatchInput = z.infer<typeof skillPatchSchema>;

export const skillVersionCreateSchema = z.object({
  content: skillContentSchema,
  changelog: z.string().max(500).default(''),
  mcp_dependencies: z.array(mcpDependencySchema).max(20).optional(),
});
export type SkillVersionCreateInput = z.infer<typeof skillVersionCreateSchema>;

export const skillRollbackSchema = z.object({
  version: z.string().trim().min(1).max(20),
});

export const skillTestSchema = z.object({
  input: z.string().max(20000).default(''),
});

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
  mcp_dependencies: SkillMcpDependency[];
  created_at: string | null;
  updated_at: string | null;
  versions?: SkillVersionSummary[];
  stats?: { bound_task_count: number };
}

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
