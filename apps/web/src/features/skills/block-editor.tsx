import { ChevronDown, ChevronUp, Plus, Trash2 } from 'lucide-react';
import { Button, Field, Input, Menu, Select, Textarea } from '@/components/ui';
import { cn } from '@/lib/cn';
import { BLOCK_KIND_META, blockTitle, createBlock } from './meta';
import type { SkillBlock, SkillBlockKind, SkillContent } from './types';

/**
 * 可视化模式的块列表编辑（2.md 11.1 简化实现）：
 * - 增删块（菜单按 kind 加）、上移下移；
 * - 块表单按 kind 切换字段（prompt/steps/condition/script/humanInstruction/tool）；
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
  onPatch,
  onSetEntry,
  onRemove,
  onMove,
}: BlockCardProps) {
  const meta = BLOCK_KIND_META[block.kind];

  return (
    <div
      className={cn(
        'rounded-card border bg-bg-surface p-3 shadow-card',
        isEntry ? 'border-primary' : 'border-border',
      )}
    >
      <div className="flex items-center gap-2">
        <span className={cn('rounded-tag px-1.5 py-0.5 text-badge', meta.kindClass)}>{meta.label}</span>
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
        {block.kind === 'prompt' || block.kind === 'knowledge' ? (
          <Field label="提示词内容" hint="可用 {{input.xxx}}、{{prev.output}} 等变量">
            <Textarea
              value={block.prompt ?? ''}
              rows={3}
              onChange={(event) => onPatch({ prompt: event.target.value })}
            />
          </Field>
        ) : null}

        {block.kind === 'step' ? (
          <Field label="步骤列表" hint="每行一步">
            <Textarea
              value={(block.steps ?? []).join('\n')}
              rows={3}
              onChange={(event) =>
                onPatch({ steps: event.target.value.split('\n').map((line) => line.trimEnd()) })
              }
            />
          </Field>
        ) : null}

        {block.kind === 'script' ? (
          <Field label="脚本">
            <Textarea
              value={block.script ?? ''}
              rows={4}
              className="font-mono"
              onChange={(event) => onPatch({ script: event.target.value })}
            />
          </Field>
        ) : null}

        {block.kind === 'human' ? (
          <Field label="人工指引">
            <Textarea
              value={block.humanInstruction ?? ''}
              rows={3}
              onChange={(event) => onPatch({ humanInstruction: event.target.value })}
            />
          </Field>
        ) : null}

        {block.kind === 'tool' ? (
          <Field label="工具（server/tool）" hint="需与发布时的 MCP 依赖声明一致">
            <Input
              value={block.tool ?? ''}
              placeholder="github/get_pull_request"
              onChange={(event) => onPatch({ tool: event.target.value })}
            />
          </Field>
        ) : null}

        {block.kind === 'decision' ? (
          <>
            <Field label="判断条件">
              <Input
                value={block.condition ?? ''}
                placeholder="例如：测试是否全部通过"
                onChange={(event) => onPatch({ condition: event.target.value })}
              />
            </Field>
            <div className="flex flex-col gap-2">
              <p className="text-aux text-text-secondary">分支 → 目标块</p>
              {(block.next ?? []).map((next, nextIndex) => (
                <div key={nextIndex} className="flex items-center gap-2">
                  <Input
                    value={next.when}
                    placeholder="分支条件（是/否）"
                    className="h-7 w-40 text-aux"
                    onChange={(event) =>
                      onPatch({
                        next: (block.next ?? []).map((item, i) =>
                          i === nextIndex ? { ...item, when: event.target.value } : item,
                        ),
                      })
                    }
                  />
                  <span className="text-aux text-text-tertiary">→</span>
                  <Select
                    className="h-7 flex-1 text-aux"
                    value={next.to}
                    options={targetOptions}
                    onChange={(event) =>
                      onPatch({
                        next: (block.next ?? []).map((item, i) =>
                          i === nextIndex ? { ...item, to: event.target.value } : item,
                        ),
                      })
                    }
                  />
                  <Button
                    variant="ghost"
                    size="iconSm"
                    aria-label="删除分支"
                    onClick={() =>
                      onPatch({ next: (block.next ?? []).filter((_, i) => i !== nextIndex) })
                    }
                  >
                    <Trash2 className="size-4" />
                  </Button>
                </div>
              ))}
              <Button
                variant="ghost"
                size="sm"
                className="self-start"
                onClick={() => onPatch({ next: [...(block.next ?? []), { when: '', to: '' }] })}
              >
                添加分支
              </Button>
            </div>
          </>
        ) : null}
      </div>
    </div>
  );
}
