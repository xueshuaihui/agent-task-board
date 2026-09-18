/**
 * 技能管理类型（1.md 第八章 + 后端契约）。
 *
 * 后端尚未实现，字段名按契约走 snake_case（与 api/types.ts 的 Skill 无关，
 * 那是任务引用技能的轻量类型，不要混淆）。
 */

export type SkillType =
  | 'prompt'
  | 'steps'
  | 'flow'
  | 'script'
  | 'knowledge'
  | 'composite'
  | 'workflow';

export type SkillStatus = 'DRAFT' | 'PUBLISHED' | 'ARCHIVED';

/** 块类型（1.md 8.3；契约只要求这七种，其余留给后端扩展）。 */
export type SkillBlockKind =
  | 'prompt'
  | 'step'
  | 'decision'
  | 'script'
  | 'knowledge'
  | 'human'
  | 'tool';

/** 技能内容（1.md 第八章 content JSON）：块 + 入口块 id。 */
export interface SkillContent {
  blocks: SkillBlock[];
  entryBlockId: string | null;
}

export interface SkillBlockNext {
  when: string;
  to: string;
}

export interface SkillBlock {
  id: string;
  kind: SkillBlockKind;
  title: string;
  /** prompt / decision / knowledge / human 用。 */
  prompt?: string;
  condition?: string;
  humanInstruction?: string;
  /** decision 块的分支：{when, to}，to 是目标块 id。 */
  next?: SkillBlockNext[];
  /** step 块的子步骤。 */
  steps?: string[];
  script?: string;
  /** tool 块：`server/tool` 形态，与 mcp_dependencies 对应。 */
  tool?: string;
}

export interface SkillMcpDependency {
  server: string;
  tools: string[];
  required: boolean;
  reason?: string;
}

export interface SkillVersionSummary {
  version: string;
  changelog?: string;
  created_at: string;
  current: boolean;
}

export interface SkillStats {
  bound_task_count: number;
}

export interface Skill {
  id: string;
  name: string;
  type: SkillType;
  status: SkillStatus;
  description: string;
  tags: string[];
  current_version: string;
  content: SkillContent;
  mcp_dependencies: SkillMcpDependency[];
  created_at: string;
  updated_at: string;
  /** 详情接口才返回。 */
  versions?: SkillVersionSummary[];
  stats?: SkillStats;
}

export interface SkillQuery {
  keyword?: string;
  type?: SkillType | '';
  status?: SkillStatus | '';
  tag?: string;
}

export interface SkillListResult {
  items: Skill[];
  total: number;
}

export interface SkillCreateInput {
  name: string;
  type: SkillType;
  description: string;
  tags: string[];
  content?: SkillContent;
}

export interface SkillPatchInput {
  name?: string;
  description?: string;
  tags?: string[];
  content?: SkillContent;
  status?: SkillStatus;
}

export interface SkillVersionCreateInput {
  content: SkillContent;
  changelog: string;
  /** 契约补充：随版本提交 MCP 依赖声明（后端按此实现）。 */
  mcp_dependencies?: SkillMcpDependency[];
}

export interface SkillTestResult {
  ok: boolean;
  logs: string[];
  output: string;
}

/** GET /skills/:id/export 的 .atskill 文件内容。 */
export interface SkillExportPayload {
  name: string;
  type: SkillType;
  content: SkillContent;
  version: string;
  mcpDependencies: SkillMcpDependency[];
  exportedAt: string;
}

/** 绑定任务列表（契约补充：GET /skills/:id/tasks，后端按此实现，见 README）。 */
export interface SkillBoundTask {
  id: string;
  title: string;
  status: string;
}

export interface SkillBoundTaskList {
  items: SkillBoundTask[];
  total: number;
}
