import { ChevronDown, ChevronUp, Plus, Trash2 } from 'lucide-react';
import { Button, Input, Menu } from '@/components/ui';
import { cn } from '@/lib/cn';
import { BLOCK_KIND_META, blockTitle, createBlock, inferVariableOptions } from './meta';
import { BlockFields } from './block-fields';
import type { SkillBlock, SkillBlockKind, SkillContent } from './types';

/**
 * 可视化模式的块列表编辑（1.md 8.3 可视化模式，2.md 11.1 简化实现）：
 * - 增删块（菜单按 15 类 kind 加）、上移下移；
 * - 字段表单抽到 block-fields.tsx（与结构化模式共用），文本字段带变量插入；
 * - 块间连线不画布拖线，用 next 分支的目标块下拉（decision 块可增删分支）；
 * - 入口块在下拉里标记，切换入口即改 content.entryBlockId。
 */

const KIND_OPTIONS = (Object.keys(BLOCK_KIND_META) as SkillBlockKind[]).map((kind) => ({
  value: kind,
  label: BLOCK_KIND_META[kind].label,
}));

export interface BlockEditorProps {
  content: SkillContent;
  onChange: (next: SkillContent) => void;
}

export function BlockEditor({ content, onChange }: BlockEditorProps) {
  const blocks = content.blocks;
  const targetOptions = [
    { value: '', label: '（不跳转）' },
    ...blocks.map((block, index) => ({
      value: block.id,
      label: blockTitle(block, index),
    })),
  ];
  const variableOptions = inferVariableOptions(content);

  const patchBlock = (id: string, patch: Partial<SkillBlock>) => {
    onChange({
      ...content,
      blocks: blocks.map((block) => (block.id === id ? { ...block, ...patch } : block)),
    });
  };

  const addBlock = (kind: SkillBlockKind) => {
    const block = createBlock(kind, blocks.length);
    onChange({ ...content, blocks: [...blocks, block] });
  };

  const removeBlock = (id: string) => {
    const rest = blocks.filter((block) => block.id !== id);
    onChange({
      entryBlockId: content.entryBlockId === id ? (rest[0]?.id ?? null) : content.entryBlockId,
      blocks: rest,
    });
  };

  const moveBlock = (index: number, delta: -1 | 1) => {
    const target = index + delta;
    if (target < 0 || target >= blocks.length) return;
    const next = [...blocks];
    [next[index], next[target]] = [next[target], next[index]];
    onChange({ ...content, blocks: next });
  };

  return (
    <div className="flex flex-col gap-3">
      {blocks.map((block, index) => (
        <BlockCard
          key={block.id}
          block={block}
          index={index}
          total={blocks.length}
          isEntry={content.entryBlockId === block.id}
          targetOptions={targetOptions}
          variableOptions={variableOptions}
          onPatch={(patch) => patchBlock(block.id, patch)}
          onSetEntry={() => onChange({ ...content, entryBlockId: block.id })}
          onRemove={() => removeBlock(block.id)}
          onMove={(delta) => moveBlock(index, delta)}
        />
      ))}
      <div className="flex items-center gap-2">
        <Menu
          width={180}
          trigger={({ toggle }) => (
            <Button size="sm" icon={<Plus className="size-4" />} onClick={toggle}>
              添加块
            </Button>
          )}
          groups={[
            {
              items: KIND_OPTIONS.map((option) => ({
                id: option.value,
                label: option.label,
                onSelect: () => addBlock(option.value as SkillBlockKind),
              })),
            },
          ]}
        />
        {blocks.length === 0 ? (
          <span className="text-aux text-text-tertiary">还没有内容块，先添加一个</span>
        ) : null}
      </div>
    </div>
  );
}

interface BlockCardProps {
  block: SkillBlock;
  index: number;
  total: number;
  isEntry: boolean;
  targetOptions: { value: string; label: string }[];
  variableOptions: ReturnType<typeof inferVariableOptions>;
  onPatch: (patch: Partial<SkillBlock>) => void;
  onSetEntry: () => void;
  onRemove: () => void;
  onMove: (delta: -1 | 1) => void;
}

function BlockCard({
  block,
  index,
  total,
  isEntry,
  targetOptions,
  variableOptions,
  onPatch,
  onSetEntry,
  onRemove,
  onMove,
}: BlockCardProps) {
  const meta = BLOCK_KIND_META[block.kind];
  const Icon = meta.icon;

  return (
    <div
      className={cn(
        'rounded-card border bg-bg-surface p-3 shadow-card',
        isEntry ? 'border-primary' : 'border-border',
      )}
    >
      <div className="flex items-center gap-2">
        <span className={cn('inline-flex items-center gap-1 rounded-tag px-1.5 py-0.5 text-badge', meta.kindClass)}>
          <Icon className="size-3.5" />
          {meta.label}
        </span>
        <Input
          value={block.title}
          placeholder={blockTitle(block, index)}
          className="h-7 flex-1 text-aux"
          onChange={(event) => onPatch({ title: event.target.value })}
        />
        <Button variant="ghost" size="iconSm" aria-label="上移" disabled={index === 0} onClick={() => onMove(-1)}>
          <ChevronUp className="size-4" />
        </Button>
        <Button
          variant="ghost"
          size="iconSm"
          aria-label="下移"
          disabled={index === total - 1}
          onClick={() => onMove(1)}
        >
          <ChevronDown className="size-4" />
        </Button>
        <Button variant="ghost" size="iconSm" aria-label="设为入口" disabled={isEntry} onClick={onSetEntry}>
          入口
        </Button>
        <Button variant="ghost" size="iconSm" aria-label="删除块" onClick={onRemove}>
          <Trash2 className="size-4" />
        </Button>
      </div>

      <div className="mt-3 flex flex-col gap-3">
        <BlockFields
          block={block}
          variableOptions={variableOptions}
          targetOptions={targetOptions}
          onPatch={onPatch}
        />
      </div>
    </div>
  );
}
