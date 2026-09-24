import type { LucideIcon } from 'lucide-react';
import {
  ArrowDownToLine,
  ArrowRightLeft,
  ArrowUpFromLine,
  BookOpen,
  Inbox,
  Laptop,
  ListChecks,
  MessageSquare,
  Package,
  RefreshCw,
  ShieldAlert,
  Split,
  StickyNote,
  Terminal,
  User,
  Wrench,
  Zap,
} from 'lucide-react';
import type { OnError, ParallelMerge, SkillBlock, SkillBlockKind, SkillCategory, SkillCategoryOrNone, SkillContent, SkillOrigin, SkillStatus, SkillType } from './types';

/**
 * 技能类型的展示元数据（2.md 10.1/10.2、1.md 8.2）。图标用 lucide 线性图标，
 * 与现有列表页/看板卡片同语言，不引 emoji。
 */
export const SKILL_TYPE_META: Record<SkillType, { label: string; description: string }> = {
  prompt: { label: '提示词', description: '简单、单步的指令' },
  steps: { label: '步骤列表', description: '多步骤、无分支' },
  workflow: { label: '工作流', description: '多步骤、可带输入输出' },
  flow: { label: '流程图', description: '有分支、循环' },
  script: { label: '脚本', description: '确定性操作' },
  knowledge: { label: '知识', description: '引用文档与资料' },
  composite: { label: '技能组合', description: '编排多个技能' },
};

export const SKILL_TYPE_OPTIONS = (Object.keys(SKILL_TYPE_META) as SkillType[]).map((type) => ({
  value: type,
  label: SKILL_TYPE_META[type].label,
}));

export const SKILL_STATUS_META: Record<SkillStatus, { label: string; className: string }> = {
  DRAFT: { label: '草稿', className: 'bg-status-backlog-soft text-status-backlog' },
  PUBLISHED: { label: '已发布', className: 'bg-status-done-soft text-status-done' },
  ARCHIVED: { label: '已归档', className: 'bg-bg-muted text-text-secondary' },
};

/**
 * v0.0.4 W2 §9.1/§9.10 三来源展示元数据（对应 api SKILL_ORIGINS）：
 * default 内置默认（应用预置只读）/ custom 自定义 / imported 三方（手动导入）。
 * PRD 图标 📦/💻/📥 按本文件惯例折算成 lucide 线性图标。
 */
export const SKILL_ORIGIN_META: Record<
  SkillOrigin,
  { label: string; icon: LucideIcon; className: string }
> = {
  default: { label: '默认技能', icon: Package, className: 'bg-bg-muted text-text-secondary' },
  custom: { label: '自定义技能', icon: Laptop, className: 'bg-primary-light text-primary' },
  imported: { label: '三方技能', icon: Inbox, className: 'bg-status-ready-soft text-status-ready' },
};

export const SKILL_ORIGIN_OPTIONS = (Object.keys(SKILL_ORIGIN_META) as SkillOrigin[]).map((origin) => ({
  value: origin,
  label: SKILL_ORIGIN_META[origin].label,
}));

/**
 * 技能分类受控词表（PRD §9.2，C-4 读侧收口）：分类是 skills.category 真列
 * （api 0015 迁移），前端直读 skill.category，分类筛选选项恒等于本词表 + 未分类，
 * 不再由 tags 减法推导。单一事实源在 apps/api/src/skills/skill-categories.ts，
 * 本数组必须与其逐字等值、顺序一致——改词表必须两边同步
 * （守护测试 __tests__/skill-categories.test.ts 从 api 源文件抽取比对，防漂移）。
 * 历史「官方/社区」受众词已作废（出处由 source_type 三来源承载），tags 是纯自由标签。
 */
export const SKILL_CATEGORIES: readonly SkillCategory[] = [
  '开学季',
  '教育学习',
  '投资理财',
  '方案写作',
  '内容创作',
  '推荐',
  'Office办公',
  '实用工具',
  '数据分析',
  '开发编程',
  '资讯研究',
  '质量保障',
];

/** 「未分类」= category 列默认值 ''（0015 DEFAULT ''），筛选匹配用。 */
export const UNCATEGORIZED_CATEGORY = '' as const;

/** 未分类的展示文案（筛选 chip / 子技能分组组头），未分类恒排最后。 */
export const UNCATEGORIZED_LABEL = '未分类';

/**
 * 分类单选/多选的可选项（C-5 写侧）：12 词 + 未分类共 13 项，按词表顺序，
 * 「未分类」恒排最后。value 即 category 列合法值（'' = 未分类）。
 * 创建向导与编辑器共用，避免两处各拼一份。
 */
export const SKILL_CATEGORY_OPTIONS: readonly { value: SkillCategoryOrNone; label: string }[] = [
  ...SKILL_CATEGORIES.map((value) => ({ value, label: value })),
  { value: UNCATEGORIZED_CATEGORY, label: UNCATEGORIZED_LABEL },
];

/** 块类型元数据（1.md 8.3 的 PRD 15 类；图标用 lucide，不引 emoji）。 */
export const BLOCK_KIND_META: Record<
  SkillBlockKind,
  { label: string; kindClass: string; icon: LucideIcon; summary: (block: SkillBlock) => string }
> = {
  prompt: {
    label: '提示词',
    kindClass: 'bg-primary-light text-primary',
    icon: MessageSquare,
    summary: (block) => block.prompt ?? '',
  },
  step: {
    label: '步骤',
    kindClass: 'bg-status-ready-soft text-status-ready',
    icon: ListChecks,
    summary: (block) => (block.steps ?? []).join('；'),
  },
  decision: {
    label: '条件',
    kindClass: 'bg-status-review-soft text-status-review',
    icon: Split,
    summary: (block) => block.condition ?? '',
  },
  loop: {
    label: '循环',
    kindClass: 'bg-status-review-soft text-status-review',
    icon: RefreshCw,
    summary: (block) => (block.while ? `当 ${block.while}` : '') + ` · ${block.steps?.length ?? 0} 步`,
  },
  parallel: {
    label: '并行',
    kindClass: 'bg-status-running-soft text-status-running',
    icon: ArrowRightLeft,
    summary: (block) =>
      `合并 ${PARALLEL_MERGE_META[block.merge ?? 'all'].label} · ${(block.branches ?? []).length} 分支`,
  },
  tool: {
    label: '工具',
    kindClass: 'bg-bg-muted text-text-secondary',
    icon: Wrench,
    summary: (block) => [block.server, block.tool].filter(Boolean).join('/'),
  },
  knowledge: {
    label: '知识',
    kindClass: 'bg-status-done-soft text-status-done',
    icon: BookOpen,
    summary: (block) => block.prompt ?? '',
  },
  script: {
    label: '脚本',
    kindClass: 'bg-status-running-soft text-status-running',
    icon: Terminal,
    summary: (block) => block.script ?? '',
  },
  subskill: {
    label: '子技能',
    kindClass: 'bg-primary-light text-primary',
    icon: BookOpen,
    summary: (block) => block.skillRef ?? '',
  },
  human: {
    label: '人工',
    kindClass: 'bg-status-failed-soft text-status-failed',
    icon: User,
    summary: (block) => block.humanInstruction ?? '',
  },
  input: {
    label: '输入',
    kindClass: 'bg-status-ready-soft text-status-ready',
    icon: ArrowDownToLine,
    summary: (block) => [block.name, block.valueType].filter(Boolean).join('：'),
  },
  output: {
    label: '输出',
    kindClass: 'bg-status-done-soft text-status-done',
    icon: ArrowUpFromLine,
    summary: (block) => [block.name, block.valueType].filter(Boolean).join('：'),
  },
  constraint: {
    label: '约束',
    kindClass: 'bg-status-backlog-soft text-status-backlog',
    icon: ShieldAlert,
    summary: (block) => block.rule ?? '',
  },
  error_handler: {
    label: '错误处理',
    kindClass: 'bg-status-failed-soft text-status-failed',
    icon: Zap,
    summary: (block) =>
      `${ON_ERROR_META[block.onError ?? 'abort'].label}` +
      (block.onError === 'retry' && block.retryCount ? ` ×${block.retryCount}` : ''),
  },
  comment: {
    label: '注释',
    kindClass: 'bg-bg-muted text-text-secondary',
    icon: StickyNote,
    summary: (block) => block.note ?? '',
  },
};

export const PARALLEL_MERGE_META: Record<ParallelMerge, { label: string }> = {
  all: { label: '全部完成' },
  any: { label: '任一完成' },
  race: { label: '竞速' },
};

export const ON_ERROR_META: Record<OnError, { label: string }> = {
  abort: { label: '中止' },
  retry: { label: '重试' },
  skip: { label: '跳过' },
  fallback: { label: '回退' },
  continue: { label: '继续' },
};

export const VALUE_TYPE_OPTIONS = ['string', 'number', 'boolean', 'json'].map((value) => ({
  value,
  label: value,
}));

export function blockTitle(block: SkillBlock, index: number): string {
  return block.title || `${BLOCK_KIND_META[block.kind].label} ${index + 1}`;
}

export function createBlock(kind: SkillBlockKind, seedIndex: number): SkillBlock {
  const id = `block-${Date.now().toString(36)}-${seedIndex}`;
  const base: SkillBlock = { id, kind, title: '' };
  if (kind === 'prompt' || kind === 'knowledge') base.prompt = '';
  if (kind === 'step' || kind === 'loop') base.steps = [];
  if (kind === 'decision') {
    base.condition = '';
    base.next = [
      { when: '是', to: '' },
      { when: '否', to: '' },
    ];
  }
  if (kind === 'loop') base.while = '';
  if (kind === 'parallel') {
    base.merge = 'all';
    base.branches = [''];
  }
  if (kind === 'script') base.script = '';
  if (kind === 'human') base.humanInstruction = '';
  if (kind === 'tool') {
    base.server = '';
    base.tool = '';
    base.argsTemplate = '';
  }
  if (kind === 'subskill') base.skillRef = '';
  if (kind === 'input' || kind === 'output') {
    base.name = '';
    base.valueType = 'string';
    base.required = kind === 'input';
  }
  if (kind === 'constraint') base.rule = '';
  if (kind === 'error_handler') {
    base.onError = 'abort';
    base.retryCount = 3;
    base.timeoutMs = undefined;
  }
  if (kind === 'comment') base.note = '';
  return base;
}

export function emptyContent(): SkillContent {
  const first = createBlock('prompt', 0);
  first.title = '开始';
  return { blocks: [first], entryBlockId: first.id };
}

/**
 * 模板起步（2.md 10.3「从模板创建」的轻量实现）。
 * 起步块的 next 只往前走、不回指：next 成环会被发布检查（`cyclicBlockIds`）判为 error 而永远发不出去，
 * 需要重试语义时用 1.md 8.3 的循环块。
 */
export function templateContent(type: SkillType): SkillContent {
  if (type === 'prompt' || type === 'knowledge') {
    return emptyContent();
  }
  if (type === 'script') {
    const block = createBlock('script', 0);
    block.title = '执行脚本';
    return { blocks: [block], entryBlockId: block.id };
  }
  const a = createBlock('step', 0);
  a.title = '分析';
  const b = createBlock('decision', 1);
  b.title = '是否完成';
  const c = createBlock('step', 2);
  c.title = '执行';
  const d = createBlock('step', 3);
  d.title = '汇总输出';
  b.next = [
    { when: '是', to: d.id },
    { when: '否', to: c.id },
  ];
  return { blocks: [a, b, c, d], entryBlockId: a.id };
}

/**
 * 发布对话框的版本号预览：semver patch 自增（v1.2.3 → v1.2.4）。
 * 真正的版本号以后端返回为准，这里只是 UI 预告。
 */
export function previewNextVersion(current: string | undefined): string {
  const match = /^v?(\d+)\.(\d+)\.(\d+)$/.exec(current ?? '');
  if (!match) return 'v0.1.0';
  return `v${match[1]}.${match[2]}.${Number(match[3]) + 1}`;
}

/** 块间连线（next 指针）的合法性检查：不指向不存在的块。 */
export function danglingNexts(content: SkillContent): { from: string; to: string }[] {
  const ids = new Set(content.blocks.map((block) => block.id));
  const result: { from: string; to: string }[] = [];
  for (const block of content.blocks) {
    for (const next of block.next ?? []) {
      if (next.to && !ids.has(next.to)) result.push({ from: block.id, to: next.to });
    }
  }
  return result;
}

/**
 * 循环检测（发布检查项）：沿 next 指针 DFS，找出仍在环上的块 id 集合。
 * 用每个节点的「在栈上」状态做三色标记，环上节点 = 完成探索时仍在栈上的节点。
 */
export function cyclicBlockIds(content: SkillContent): Set<string> {
  const blocks = new Map(content.blocks.map((block) => [block.id, block]));
  const state = new Map<string, 1 | 2>(); // 1=在栈上 2=已完成
  const cyclic = new Set<string>();
  const stack: string[] = [];

  const visit = (id: string) => {
    const mark = state.get(id);
    if (mark === 1) {
      // 找到环：从栈里该节点起全是环成员。
      const start = stack.indexOf(id);
      for (let i = start; i < stack.length; i += 1) cyclic.add(stack[i]);
      return;
    }
    if (mark === 2) return;
    state.set(id, 1);
    stack.push(id);
    for (const next of blocks.get(id)?.next ?? []) {
      if (next.to && blocks.has(next.to)) visit(next.to);
    }
    stack.pop();
    state.set(id, 2);
  };
  for (const block of content.blocks) visit(block.id);
  return cyclic;
}

/** 变量引用语法：{{input.x}} / {{prev.output}} / {{task.title}} / {{env.HOME}} ... */
const VARIABLE_RE = /\{\{\s*([a-zA-Z_][\w]*(?:\.[\w-]+)+)\s*\}\}/g;

/** 抽取一段文本里引用的所有变量路径（如 `input.diff`）。 */
export function collectVariables(text: string): string[] {
  const result: string[] = [];
  for (const match of text.matchAll(VARIABLE_RE)) result.push(match[1]);
  return result;
}

/** 遍历所有块的文本字段，返回 块id → 引用变量列表。 */
export function blockVariableUsage(block: SkillBlock): string[] {
  const texts: string[] = [
    block.prompt ?? '',
    block.condition ?? '',
    block.humanInstruction ?? '',
    block.while ?? '',
    block.argsTemplate ?? '',
    block.rule ?? '',
    block.note ?? '',
    ...(block.steps ?? []),
    ...(block.branches ?? []),
  ];
  return texts.flatMap((text) => collectVariables(text));
}

export interface VariableOption {
  /** 插入的完整表达式，如 `input.diff`。 */
  path: string;
  label: string;
  group: string;
}

/**
 * 变量系统辅助（1.md 8.3）：从技能 input 块与上游块输出推断可插入的变量。
 * 轻量实现：input 块的 name 生成 `input.*`；每个块的标题生成 `<id>.output`；
 * 其余按 PRD 固定给 task/group/review/env/prev。
 */
export function inferVariableOptions(content: SkillContent): VariableOption[] {
  const options: VariableOption[] = [
    { path: 'prev.output', label: '上一步输出', group: '上下文' },
    { path: 'task.title', label: '任务标题', group: '任务' },
    { path: 'task.description', label: '任务描述', group: '任务' },
    { path: 'group.name', label: '分组名称', group: '分组' },
    { path: 'review.suggestion', label: '审核意见', group: '审核' },
    { path: 'env.HOME', label: '环境变量 HOME', group: '环境' },
  ];
  for (const block of content.blocks) {
    if (block.kind === 'input' && block.name) {
      options.push({ path: `input.${block.name}`, label: `输入 ${block.name}`, group: '技能输入' });
    }
  }
  for (const block of content.blocks) {
    if (block.kind !== 'input') {
      options.push({
        path: `${block.id}.output`,
        label: `「${blockTitle(block, 0)}」的输出`,
        group: '块输出',
      });
    }
  }
  // 全局变量由工作台设置提供，前端不建模，给个语法示例。
  options.push({ path: 'global.变量名', label: '全局变量（示例）', group: '全局' });
  return options;
}

export interface VariableWarning {
  blockId: string;
  variable: string;
  message: string;
}

/**
 * 变量拼写提示（警告，不阻断发布）：引用了 `{{...}}` 但不在可选列表里时给出。
 * `global.*` 与 `env.*` 不校验后缀（运行时才能知道全集）。
 */
export function variableWarnings(content: SkillContent): VariableWarning[] {
  const known = new Set(inferVariableOptions(content).map((option) => option.path));
  const warnings: VariableWarning[] = [];
  for (const block of content.blocks) {
    for (const variable of blockVariableUsage(block)) {
      const [root] = variable.split('.');
      const openRoot = root === 'global' || root === 'env';
      if (!openRoot && !known.has(variable)) {
        warnings.push({
          blockId: block.id,
          variable,
          message: `引用了未声明的变量 {{${variable}}}（来源：块「${blockTitle(block, 0)}」）`,
        });
      }
    }
  }
  return warnings;
}

/* -------------------------------- 起步模板 -------------------------------- */

export interface SkillStarterTemplate {
  id: string;
  name: string;
  type: SkillType;
  description: string;
  tags: string[];
  /**
   * 模板自带分类（C-5）：词表内值、不允许 ''——模板是给当范用的，
   * 自带未分类等于示范错误用法（守护测试逐条钉死）。
   */
  category: SkillCategoryOrNone;
  content: SkillContent;
}

function seedBlocks(
  specs: { kind: SkillBlockKind; title: string; patch?: (block: SkillBlock) => void }[],
): SkillContent {
  const blocks = specs.map((spec, index) => {
    const block = createBlock(spec.kind, index);
    block.title = spec.title;
    spec.patch?.(block);
    return block;
  });
  return { blocks, entryBlockId: blocks[0]?.id ?? null };
}

/**
 * 内置起步模板（2.md 10.3「从模板起步」）：8 个常用场景的完整正文，
 * 选中后以模板的名称/类型/描述/标签/分类/内容预填创建向导，均可改。
 * 每个 prompt/step 块都带可直接使用的指令正文（含 {{input.*}} / {{task.*}} 变量示例），
 * 源码模式下导出即为完整可用的 SKILL.md。
 */
export const SKILL_STARTER_TEMPLATES: SkillStarterTemplate[] = [
  {
    id: 'code-review',
    name: '代码审查',
    type: 'workflow',
    description: '对一次 diff 做多维审查并输出结构化评审意见',
    tags: ['review', 'quality'],
    category: '质量保障',
    content: seedBlocks([
      {
        kind: 'input',
        title: '输入 diff',
        patch: (b) => {
          b.name = 'diff';
          b.valueType = 'string';
          b.required = true;
        },
      },
      {
        kind: 'prompt',
        title: '逐项审查',
        patch: (b) => {
          b.prompt = [
            '你是一名资深代码评审员。请针对任务「{{task.title}}」的以下改动做逐项审查：',
            '',
            '{{input.diff}}',
            '',
            '按四个维度逐一检查，每个维度先给结论（通过/有风险），再列出具体问题：',
            '1. 正确性：边界条件、空值处理、并发与事务一致性；',
            '2. 安全性：注入、越权、敏感信息泄露；',
            '3. 可读性：命名、函数长度、重复代码；',
            '4. 性能：不必要的循环嵌套、N+1 查询、大对象拷贝。',
            '不要泛泛而谈，每条意见必须落到具体代码片段。',
          ].join('\n');
        },
      },
      {
        kind: 'constraint',
        title: '输出约定',
        patch: (b) => {
          b.rule = '每条意见必须给出文件路径、行号与严重级别（blocker/major/minor），并附修改建议；没有问题的维度明确写「通过」，不要留空。';
        },
      },
    ]),
  },
  {
    id: 'bug-triage',
    name: 'Bug 定位',
    type: 'flow',
    description: '从报错信息出发定位根因，带条件分支与重试',
    tags: ['debug'],
    category: '质量保障',
    content: seedBlocks([
      {
        kind: 'input',
        title: '输入报错信息',
        patch: (b) => {
          b.name = 'error_report';
          b.valueType = 'string';
          b.required = true;
        },
      },
      {
        kind: 'prompt',
        title: '分析报错',
        patch: (b) => {
          b.prompt = [
            '请分析任务「{{task.title}}」的报错信息，提取关键线索：',
            '',
            '{{input.error_report}}',
            '',
            '依次列出：完整的错误类型与消息、发生的代码位置（文件/函数/行号）、',
            '触发条件（什么输入或状态下出现）、以及 2-3 个最可能的根因假设，按可能性排序。',
          ].join('\n');
        },
      },
      {
        kind: 'decision',
        title: '根因是否明确',
        patch: (b) => {
          b.condition = '根据已有报错信息与代码上下文，能否确定唯一且可验证的根因？';
          b.next = [
            { when: '是：根因明确，可直接给出修复方案', to: '' },
            { when: '否：存在多个假设或信息不足，需要补充排查', to: '' },
          ];
        },
      },
      {
        kind: 'step',
        title: '补充排查',
        patch: (b) => {
          b.steps = [
            '针对每个未排除的根因假设，设计最小复现步骤（日志埋点、断点或最小用例）',
            '逐个执行验证，记录每个假设的验证结果（成立/排除）',
            '若所有假设均被排除，回到「分析报错」重新提取线索（最多重试 2 轮）',
          ];
        },
      },
      {
        kind: 'step',
        title: '输出结论',
        patch: (b) => {
          b.steps = [
            '写明根因：触发路径、缺陷代码位置与成因解释',
            '给出修复建议：具体代码改动方向与回归测试用例',
            '标注影响面：受影响的调用方与需要同步修改的位置',
          ];
        },
      },
    ]),
  },
  {
    id: 'weekly-report',
    name: '周报生成',
    type: 'steps',
    description: '汇总本周期任务进展生成周报草稿',
    tags: ['report'],
    category: '方案写作',
    content: seedBlocks([
      {
        kind: 'step',
        title: '收集进展',
        patch: (b) => {
          b.steps = [
            '读取任务「{{task.title}}」周期内的已完成任务，记录任务标题与完成时间',
            '读取进行中任务，记录当前进度与预计完成时间',
            '读取被阻塞任务，记录阻塞原因与需要协调的对象',
          ];
        },
      },
      {
        kind: 'step',
        title: '归纳要点',
        patch: (b) => {
          b.steps = [
            '按分组归集，每组用一句话概括本周主线进展，突出可量化的产出',
            '提炼风险与依赖：哪些事项需要上级决策或外部支持，写明期望的解决时间',
          ];
        },
      },
      {
        kind: 'output',
        title: '周报文本',
        patch: (b) => {
          b.name = 'report';
          b.valueType = 'string';
          b.required = false;
        },
      },
    ]),
  },
  {
    id: 'doc-translate',
    name: '文档翻译',
    type: 'prompt',
    description: '保持术语表一致的技术文档翻译',
    tags: ['i18n'],
    category: '内容创作',
    content: seedBlocks([
      {
        kind: 'input',
        title: '输入原文',
        patch: (b) => {
          b.name = 'source_text';
          b.valueType = 'string';
          b.required = true;
        },
      },
      {
        kind: 'prompt',
        title: '执行翻译',
        patch: (b) => {
          b.prompt = [
            '请将以下技术文档翻译为中文（若原文是中文则译为英文），原文来自任务「{{task.title}}」：',
            '',
            '{{input.source_text}}',
            '',
            '翻译要求：',
            '1. 技术术语首次出现时在括号内保留英文原文，如「容器（container）」；',
            '2. 代码块、命令行、配置键名、专有名词不翻译；',
            '3. 保持原文的标题层级、列表结构与段落划分，不增删信息；',
            '4. 语气专业平实，避免口语化和过度修饰。',
          ].join('\n');
        },
      },
      {
        kind: 'constraint',
        title: '输出约定',
        patch: (b) => {
          b.rule = '只输出译文正文，不要附加翻译说明；术语表若有冲突，以术语表为准并在译文中保持全篇一致。';
        },
      },
    ]),
  },
  {
    id: 'api-smoke',
    name: '接口冒烟测试',
    type: 'script',
    description: '对目标服务的核心接口跑一轮确定性冒烟脚本',
    tags: ['testing'],
    category: '质量保障',
    content: seedBlocks([
      {
        kind: 'input',
        title: '输入服务地址',
        patch: (b) => {
          b.name = 'base_url';
          b.valueType = 'string';
          b.required = true;
        },
      },
      {
        kind: 'script',
        title: '执行冒烟脚本',
        patch: (b) => {
          b.script = [
            '// 冒烟：核心接口只验证可达性与状态码，不做深度断言。',
            "const health = await fetch(`${base_url}/healthz`);",
            "assert(health.status === 200, '健康检查失败');",
            '',
            "const list = await fetch(`${base_url}/api/v1/items?page_size=1`);",
            "assert(list.status === 200, '列表接口失败');",
            '',
            'console.log(`smoke ok: ${base_url}`);',
          ].join('\n');
        },
      },
      {
        kind: 'error_handler',
        title: '失败处理',
        patch: (b) => {
          b.onError = 'retry';
          b.retryCount = 2;
          b.timeoutMs = 30000;
        },
      },
    ]),
  },
  {
    id: 'repo-knowledge',
    name: '代码仓库知识',
    type: 'knowledge',
    description: '沉淀代码仓库架构、约定与常见坑的参考资料',
    tags: ['knowledge'],
    category: '开发编程',
    content: seedBlocks([
      {
        kind: 'knowledge',
        title: '仓库概况',
        patch: (b) => {
          b.prompt = [
            '本仓库是 monorepo 结构：apps/ 下为可部署应用，packages/ 下为共享包。',
            '技术栈：TypeScript + React（前端）、NestJS（API）、Prisma（ORM）。',
            '提交遵循 Conventional Commits；分支命名 feature/<日期>-<主题>。',
            '回答问题时优先引用本节约定，再给出具体建议。',
          ].join('\n');
        },
      },
      {
        kind: 'knowledge',
        title: '常见坑',
        patch: (b) => {
          b.prompt = [
            '1. 数据库迁移必须用 `npm run prisma:migrate`，不要手改 schema 后直接 db push；',
            '2. 前端禁止直接 import apps/api 的类型，跨端共享类型放 packages/shared；',
            '3. 缓存失效统一走 qk.* query key 前缀，禁止散落 invalidate；',
            '4. 环境变量新增后必须同步更新 .env.example 与部署模板。',
          ].join('\n');
        },
      },
    ]),
  },
  {
    id: 'release-composite',
    name: '发布流水线',
    type: 'composite',
    description: '编排测试、构建、发布三个子技能完成一次发版',
    tags: ['release'],
    category: '开发编程',
    content: seedBlocks([
      {
        kind: 'subskill',
        title: '跑测试',
        patch: (b) => {
          b.skillRef = '接口冒烟测试';
        },
      },
      {
        kind: 'constraint',
        title: '准入条件',
        patch: (b) => {
          b.rule = '测试子技能必须全部通过才允许进入构建；任何失败都中止流水线并在结论中注明失败的用例名。';
        },
      },
      {
        kind: 'subskill',
        title: '执行构建',
        patch: (b) => {
          b.skillRef = '构建技能';
        },
      },
      {
        kind: 'subskill',
        title: '发布产物',
        patch: (b) => {
          b.skillRef = '发布技能';
        },
      },
    ]),
  },
  {
    id: 'parallel-summaries',
    name: '并行摘要',
    type: 'workflow',
    description: '并行汇总多份材料再合并成单一结论',
    tags: ['summary'],
    category: 'Office办公',
    content: seedBlocks([
      {
        kind: 'input',
        title: '材料列表',
        patch: (b) => {
          b.name = 'documents';
          b.valueType = 'json';
          b.required = true;
        },
      },
      {
        kind: 'parallel',
        title: '并行摘要',
        patch: (b) => {
          b.merge = 'all';
          b.branches = [
            '摘要分支 A：对材料列表中的第 1 组文档，各写 3 句以内的要点摘要',
            '摘要分支 B：对材料列表中的第 2 组文档，各写 3 句以内的要点摘要',
            '摘要分支 C：单独提取所有材料中的风险项与待办事项，逐条列出',
          ];
        },
      },
      {
        kind: 'prompt',
        title: '合并结论',
        patch: (b) => {
          b.prompt = [
            '请把各并行分支的摘要合并为围绕任务「{{task.title}}」的单一结论：',
            '1. 用一段话概括整体要点，不超过 5 句；',
            '2. 汇总各分支提到的重复信息并去重；',
            '3. 单独列出风险项与待办清单，标注来源材料；',
            '4. 若分支之间有矛盾结论，显式指出矛盾点而不是自行裁决。',
          ].join('\n');
        },
      },
      {
        kind: 'output',
        title: '合并结论',
        patch: (b) => {
          b.name = 'summary';
          b.valueType = 'string';
          b.required = false;
        },
      },
    ]),
  },
];
