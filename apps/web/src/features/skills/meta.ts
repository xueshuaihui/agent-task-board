import type { SkillBlock, SkillBlockKind, SkillContent, SkillStatus, SkillType } from './types';

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

/** 块类型元数据（1.md 8.3 的七种契约块）。 */
export const BLOCK_KIND_META: Record<
  SkillBlockKind,
  { label: string; kindClass: string; summary: (block: SkillBlock) => string }
> = {
  prompt: {
    label: '提示词',
    kindClass: 'bg-primary-light text-primary',
    summary: (block) => block.prompt ?? '',
  },
  step: {
    label: '步骤',
    kindClass: 'bg-status-ready-soft text-status-ready',
    summary: (block) => (block.steps ?? []).join('；'),
  },
  decision: {
    label: '条件',
    kindClass: 'bg-status-review-soft text-status-review',
    summary: (block) => block.condition ?? '',
  },
  script: {
    label: '脚本',
    kindClass: 'bg-status-running-soft text-status-running',
    summary: (block) => block.script ?? '',
  },
  knowledge: {
    label: '知识',
    kindClass: 'bg-status-done-soft text-status-done',
    summary: (block) => block.prompt ?? '',
  },
  human: {
    label: '人工',
    kindClass: 'bg-status-failed-soft text-status-failed',
    summary: (block) => block.humanInstruction ?? '',
  },
  tool: {
    label: '工具',
    kindClass: 'bg-bg-muted text-text-secondary',
    summary: (block) => block.tool ?? '',
  },
};

export function blockTitle(block: SkillBlock, index: number): string {
  return block.title || `${BLOCK_KIND_META[block.kind].label} ${index + 1}`;
}

export function createBlock(kind: SkillBlockKind, seedIndex: number): SkillBlock {
  const id = `block-${Date.now().toString(36)}-${seedIndex}`;
  const base: SkillBlock = { id, kind, title: '' };
  if (kind === 'prompt' || kind === 'knowledge') base.prompt = '';
  if (kind === 'step') base.steps = [];
  if (kind === 'decision') {
    base.condition = '';
    base.next = [
      { when: '是', to: '' },
      { when: '否', to: '' },
    ];
  }
  if (kind === 'script') base.script = '';
  if (kind === 'human') base.humanInstruction = '';
  if (kind === 'tool') base.tool = '';
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
