import { blockTitle } from './meta';
import type { SkillBlock, SkillContent } from './types';

/**
 * v0.0.4 W3 §9.6 版本 diff（纯函数）：历史版本快照 vs 编辑器当前草稿的块级对比。
 * 比较口径：
 * - 块按稳定 id 对齐（W2 唯一 ID 保证跨版本 id 不变）；
 * - `pos` 只是画布坐标，不算内容变更（单独给 moved 顺序信号）；
 * - 字段级变更列出差异 key，UI 用 BLOCK_KIND_META.summary 回显两端摘要。
 */

export interface SkillContentDiff {
  added: { block: SkillBlock; index: number }[];
  removed: { block: SkillBlock; index: number }[];
  changed: { before: SkillBlock; after: SkillBlock; fields: string[]; index: number }[];
  /** 相对顺序变化的块（id 集合；展示时用 index 前后对照）。 */
  reorderedIds: string[];
  entryChanged: boolean;
  fromEntryId: string | null;
  toEntryId: string | null;
  isEmpty: boolean;
}

/** 块字段级差异 key（去掉 id/kind/pos；kind 相同才会进 changed 分支，故不列）。 */
function changedFields(before: SkillBlock, after: SkillBlock): string[] {
  const keys = new Set([...Object.keys(before), ...Object.keys(after)]);
  const fields: string[] = [];
  for (const key of keys) {
    if (key === 'id' || key === 'kind' || key === 'pos') continue;
    const a = JSON.stringify((before as unknown as Record<string, unknown>)[key] ?? null);
    const b = JSON.stringify((after as unknown as Record<string, unknown>)[key] ?? null);
    if (a !== b) fields.push(key);
  }
  return fields;
}

export function diffSkillContent(from: SkillContent, to: SkillContent): SkillContentDiff {
  const fromBlocks = from.blocks ?? [];
  const toBlocks = to.blocks ?? [];
  const fromById = new Map(fromBlocks.map((block) => [block.id, block]));
  const toById = new Map(toBlocks.map((block) => [block.id, block]));

  const added = toBlocks
    .map((block, index) => ({ block, index }))
    .filter(({ block }) => !fromById.has(block.id));
  const removed = fromBlocks
    .map((block, index) => ({ block, index }))
    .filter(({ block }) => !toById.has(block.id));

  const changed = toBlocks
    .map((after, index) => {
      const before = fromById.get(after.id);
      if (!before) return null;
      const fields = changedFields(before, after);
      return fields.length > 0 ? { before, after, fields, index } : null;
    })
    .filter((item): item is { before: SkillBlock; after: SkillBlock; fields: string[]; index: number } =>
      Boolean(item),
    );

  /* 顺序：取两边共有的块，比较相对次序。 */
  const commonFromOrder = fromBlocks.filter((block) => toById.has(block.id)).map((block) => block.id);
  const commonToOrder = toBlocks.filter((block) => fromById.has(block.id)).map((block) => block.id);
  const reorderedIds =
    JSON.stringify(commonFromOrder) === JSON.stringify(commonToOrder)
      ? []
      : commonToOrder.filter((id, index) => commonFromOrder[index] !== id);

  const entryChanged = (from.entryBlockId ?? null) !== (to.entryBlockId ?? null);
  const isEmpty =
    added.length === 0 &&
    removed.length === 0 &&
    changed.length === 0 &&
    reorderedIds.length === 0 &&
    !entryChanged;

  return { added, removed, changed, reorderedIds, entryChanged, fromEntryId: from.entryBlockId, toEntryId: to.entryBlockId, isEmpty };
}

/** 差异字段 key → 中文名（与 SkillBlock 字段对齐，未知 key 原样展示）。 */
export const DIFF_FIELD_LABELS: Record<string, string> = {
  title: '标题',
  prompt: '内容',
  condition: '判断条件',
  humanInstruction: '人工指引',
  next: '分支连线',
  steps: '步骤',
  while: '循环条件',
  merge: '合并策略',
  branches: '并行分支',
  server: 'MCP Server',
  tool: '工具名',
  argsTemplate: '参数模板',
  script: '脚本',
  skillRef: '引用技能',
  name: '变量名',
  valueType: '值类型',
  required: '必填',
  rule: '规则',
  onError: '失败策略',
  retryCount: '重试次数',
  timeoutMs: '超时',
  note: '说明',
};

export function diffFieldLabel(key: string): string {
  return DIFF_FIELD_LABELS[key] ?? key;
}

/** 顺序变化提示文案：`标题（旧 i → 新 j）`。 */
export function reorderLabel(from: SkillContent, to: SkillContent, id: string): string {
  const block = to.blocks.find((item) => item.id === id);
  const fromIndex = from.blocks.findIndex((item) => item.id === id);
  const toIndex = to.blocks.findIndex((item) => item.id === id);
  const title = block ? blockTitle(block, toIndex) : id;
  return `${title}（${fromIndex + 1} → ${toIndex + 1}）`;
}

export function entryLabel(from: SkillContent, to: SkillContent, id: string | null): string {
  if (!id) return '（无）';
  const index = to.blocks.findIndex((block) => block.id === id);
  const block = to.blocks.find((block) => block.id === id);
  if (block) return blockTitle(block, Math.max(index, 0));
  const fromBlockIndex = from.blocks.findIndex((block) => block.id === id);
  const fromBlock = from.blocks.find((block) => block.id === id);
  if (fromBlock) return blockTitle(fromBlock, Math.max(fromBlockIndex, 0));
  return id;
}
