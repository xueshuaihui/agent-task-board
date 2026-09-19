import type { LucideIcon } from 'lucide-react';
import {
  ArrowDownToLine,
  ArrowRightLeft,
  ArrowUpFromLine,
  BookOpen,
  ListChecks,
  MessageSquare,
  RefreshCw,
  ShieldAlert,
  Split,
  StickyNote,
  Terminal,
  User,
  Wrench,
  Zap,
} from 'lucide-react';
import type { OnError, ParallelMerge, SkillBlock, SkillBlockKind, SkillContent, SkillStatus, SkillType } from './types';

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

/** 模板起步（2.md 10.3「从模板创建」的轻量实现）。 */
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
  c.next = [{ when: '完成', to: b.id }];
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
 * 其余按 PRD 固定给 task/project/review/env/prev。
 */
export function inferVariableOptions(content: SkillContent): VariableOption[] {
  const options: VariableOption[] = [
    { path: 'prev.output', label: '上一步输出', group: '上下文' },
    { path: 'task.title', label: '任务标题', group: '任务' },
    { path: 'task.description', label: '任务描述', group: '任务' },
    { path: 'project.name', label: '项目名称', group: '项目' },
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
 * 内置起步模板（2.md 10.3「从模板起步」）：8 个常用场景的摘要，
 * 选中后以模板的名称/类型/描述/标签/内容预填创建向导，均可改。
 */
export const SKILL_STARTER_TEMPLATES: SkillStarterTemplate[] = [
  {
    id: 'code-review',
    name: '代码审查',
    type: 'workflow',
    description: '对一次 diff 做多维审查并输出结构化评审意见',
    tags: ['review', 'quality'],
    content: seedBlocks([
      { kind: 'input', title: '输入 diff', patch: (b) => (b.name = 'diff') },
      { kind: 'prompt', title: '逐项审查', patch: (b) => (b.prompt = '按正确性 / 安全 / 可读性 / 性能逐项检查 {{input.diff}}') },
      { kind: 'constraint', title: '输出约定', patch: (b) => (b.rule = '每条意见给出文件、行号与严重级别') },
    ]),
  },
  {
    id: 'bug-triage',
    name: 'Bug 定位',
    type: 'flow',
    description: '从报错信息出发定位根因，带条件分支与重试',
    tags: ['debug'],
    content: templateContent('flow'),
  },
  {
    id: 'weekly-report',
    name: '周报生成',
    type: 'steps',
    description: '汇总本周期任务进展生成周报草稿',
    tags: ['report'],
    content: seedBlocks([
      { kind: 'step', title: '收集进展', patch: (b) => (b.steps = ['读取已完成任务', '读取进行中任务', '读取被阻塞任务']) },
      { kind: 'step', title: '归纳要点', patch: (b) => (b.steps = ['按项目分组', '提炼风险与需要的支持']) },
      { kind: 'output', title: '周报文本', patch: (b) => (b.name = 'report') },
    ]),
  },
  {
    id: 'doc-translate',
    name: '文档翻译',
    type: 'prompt',
    description: '保持术语表一致的技术文档翻译',
    tags: ['i18n'],
    content: emptyContent(),
  },
  {
    id: 'api-smoke',
    name: '接口冒烟测试',
    type: 'script',
    description: '对目标服务的核心接口跑一轮确定性冒烟脚本',
    tags: ['testing'],
    content: templateContent('script'),
  },
  {
    id: 'project-knowledge',
    name: '项目知识库',
    type: 'knowledge',
    description: '沉淀项目架构、约定与常见坑的参考资料',
    tags: ['knowledge'],
    content: templateContent('knowledge'),
  },
  {
    id: 'release-composite',
    name: '发布流水线',
    type: 'composite',
    description: '编排测试、构建、发布三个子技能完成一次发版',
    tags: ['release'],
    content: seedBlocks([
      { kind: 'subskill', title: '跑测试', patch: (b) => (b.skillRef = '接口冒烟测试') },
      { kind: 'subskill', title: '执行构建', patch: (b) => (b.skillRef = '构建技能') },
      { kind: 'subskill', title: '发布产物', patch: (b) => (b.skillRef = '发布技能') },
    ]),
  },
  {
    id: 'parallel-summaries',
    name: '并行摘要',
    type: 'workflow',
    description: '并行汇总多份材料再合并成单一结论',
    tags: ['summary'],
    content: seedBlocks([
      { kind: 'input', title: '材料列表', patch: (b) => (b.name = 'documents') },
      { kind: 'parallel', title: '并行摘要', patch: (b) => (b.branches = ['摘要材料 A', '摘要材料 B']) },
      { kind: 'prompt', title: '合并结论', patch: (b) => (b.prompt = '把各分支摘要合并为单一结论') },
    ]),
  },
];
