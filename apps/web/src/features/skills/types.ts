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

/**
 * v0.0.4 W2 技能三来源（§9.1，与 api SKILL_ORIGINS/0010 迁移 CHECK 同词表）：
 * default=内置默认（只读）/ custom=自定义（用户创建）/ imported=三方（手动导入）。
 * r2：唯一性由 id 保证、name 允许重名；三方技能不再有「导入来源」概念。
 */
export type SkillOrigin = 'default' | 'custom' | 'imported';

/**
 * 技能分类受控词表（PRD §9.2 两字段模型，C-4 读侧收口）：skills.category 是真列
 * （api 0015 迁移），取值只能是下面 12 词之一或 ''（未分类，列默认值）。
 * 单一事实源在 apps/api/src/skills/skill-categories.ts，此处为其类型化镜像，
 * 改词表必须两边同步（守护测试 __tests__/skill-categories.test.ts 逐字比对）。
 */
export type SkillCategory =
  | '开学季'
  | '教育学习'
  | '投资理财'
  | '方案写作'
  | '内容创作'
  | '推荐'
  | 'Office办公'
  | '实用工具'
  | '数据分析'
  | '开发编程'
  | '资讯研究'
  | '质量保障';

/** category 列的完整合法值：词表内分类，或 ''（未分类）。 */
export type SkillCategoryOrNone = SkillCategory | '';

/**
 * 块类型（1.md 8.3 表，PRD 15 类）。后端 content 是 passthrough JSON，
 * 前端 schema 自由扩展，后端原样存储。
 */
export type SkillBlockKind =
  | 'prompt'
  | 'step'
  | 'decision'
  | 'loop'
  | 'parallel'
  | 'tool'
  | 'knowledge'
  | 'script'
  | 'subskill'
  | 'human'
  | 'input'
  | 'output'
  | 'constraint'
  | 'error_handler'
  | 'comment';

/** 技能内容（1.md 第八章 content JSON）：块 + 入口块 id。 */
export interface SkillContent {
  blocks: SkillBlock[];
  entryBlockId: string | null;
}

export interface SkillBlockNext {
  when: string;
  to: string;
}

export type ParallelMerge = 'all' | 'any' | 'race';
export type OnError = 'abort' | 'retry' | 'skip' | 'fallback' | 'continue';

export interface SkillBlock {
  id: string;
  kind: SkillBlockKind;
  title: string;
  /** prompt / knowledge 块的正文（human 用 humanInstruction）。 */
  prompt?: string;
  condition?: string;
  humanInstruction?: string;
  /** decision 块的分支：{when, to}，to 是目标块 id。 */
  next?: SkillBlockNext[];
  /** step 块的子步骤；loop 块的循环体简表。 */
  steps?: string[];
  /** loop 块的循环条件（{while, steps[]}）。 */
  while?: string;
  /** parallel 块：合并策略 + 各分支描述。 */
  merge?: ParallelMerge;
  branches?: string[];
  /** tool 块：server、工具名、参数模板（支持 {{变量}}）。 */
  server?: string;
  tool?: string;
  argsTemplate?: string;
  script?: string;
  /** subskill 块：引用的技能 id。 */
  skillRef?: string;
  /** input / output 块：变量声明（1.md 8.3 变量系统 {{input.x}} / 输出）。 */
  name?: string;
  /** input / output 块的值类型（string/number/boolean/json/...）。 */
  valueType?: string;
  required?: boolean;
  /** constraint 块的规则。 */
  rule?: string;
  /** error_handler 块：失败策略 + 重试次数 + 超时毫秒。 */
  onError?: OnError;
  retryCount?: number;
  timeoutMs?: number;
  /** comment 块的说明（仅说明，不执行）。 */
  note?: string;
  /**
   * 流程图画布上的坐标（流程图视图写入；content 是 passthrough JSON，后端原样存储）。
   * 其他模式不读不写，只透传，删块/改字段时随块对象整体保留。
   */
  pos?: { x: number; y: number };
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

/** GET /skills/:id/versions/:version 快照（W3 §9.6 编辑器版本 diff 用，服务端原样存的 SkillContent）。 */
export interface SkillVersionSnapshot {
  version: string;
  changelog?: string;
  created_at: string;
  content: SkillContent;
  mcp_dependencies: SkillMcpDependency[];
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
  /**
   * 分类（PRD §9.2）：直读 api 真列，12 词表内或 ''（未分类）。
   * tags 是纯自由标签，与分类无关（旧「tags 减法凑分类」口径已废）。
   */
  category: SkillCategoryOrNone;
  current_version: string;
  content: SkillContent;
  mcp_dependencies: SkillMcpDependency[];
  /** W2 三来源标记（列表/详情展示 §9.10）。 */
  source: SkillOrigin;
  /** 默认技能只读（后端按 source==='default' 推导）。 */
  readonly: boolean;
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
  /** W2：按三来源筛选。 */
  source?: SkillOrigin | '';
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
  /** 分类（PRD §9.2，C-5 写侧收口）：可选，后端缺省 ''（未分类）；词表外值 422。 */
  category?: SkillCategoryOrNone;
  content?: SkillContent;
}

export interface SkillPatchInput {
  name?: string;
  description?: string;
  tags?: string[];
  /**
   * 分类两态语义（与 api patch DTO 对齐）：**字段不出现在请求体 = 不改分类**；
   * 传 `''` = 显式改为未分类。编辑器保存要始终显式提交当前值（含 ''），
   * 用户才能把技能改回未分类。
   */
  category?: SkillCategoryOrNone;
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

/** GET /skills/:id/export 的 .atskill 文件内容（W2 r2：必带 id，导入按同 id 归一）。 */
export interface SkillExportPayload {
  id: string;
  name: string;
  type: SkillType;
  content: SkillContent;
  version: string;
  mcpDependencies: SkillMcpDependency[];
  exportedAt: string;
}

/** 导入冲突策略（§9.8.4，同 ID 判定）：默认 fail=409 让用户选覆盖/跳过。 */
export type SkillImportConflict = 'fail' | 'overwrite' | 'skip';

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
