import { useState } from 'react';
import {
  DndContext,
  KeyboardSensor,
  PointerSensor,
  closestCenter,
  useSensor,
  useSensors,
  type DragEndEvent,
} from '@dnd-kit/core';
import { SortableContext, arrayMove, useSortable, verticalListSortingStrategy } from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import { ChevronDown, ChevronUp, GripVertical, Plus, Trash2 } from 'lucide-react';
import { Button, Input, Menu } from '@/components/ui';
import { cn } from '@/lib/cn';
import { BLOCK_KIND_META, blockTitle, createBlock, inferVariableOptions } from './meta';
import { BlockFields } from './block-fields';
import type { SkillBlock, SkillBlockKind, SkillContent } from './types';

/**
 * 可视化模式的块列表编辑（1.md 8.3 可视化模式，2.md 11.1 简化实现）：
 * - 增删块（菜单按 15 类 kind 加）、上移下移按钮 + 拖拽排序（dnd-kit，同列表垂直）；
 * - 键盘：聚焦块卡片本体（非内部输入框）时 Del/Backspace 删除块，需确认；
 * - 字段表单抽到 block-fields.tsx（与结构化模式共用），文本字段带变量插入；
 * - 块间连线用 next 分支的目标块下拉（decision 块可增删分支）；
 * - 入口块在下拉里标记，切换入口即改 content.entryBlockId。
 */

const KIND_OPTIONS = (Object.keys(BLOCK_KIND_META) as SkillBlockKind[]).map((kind) => ({
  value: kind,
  label: BLOCK_KIND_META[kind].label,
}));

export interface BlockEditorProps {
  content: SkillContent;
  onChange: (next: SkillContent) => void;
  /** W3 §9.1：默认技能只读——隐藏增删/排序/入口操作，字段表单只读呈现。 */
  readOnly?: boolean;
}

export function BlockEditor({ content, onChange, readOnly = false }: BlockEditorProps) {
  const blocks = content.blocks;
  const [dragging, setDragging] = useState(false);
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 4 } }),
    /* 拖拽用方向键激活（Space 留给输入），拖完 Enter/空格落点。 */
    useSensor(KeyboardSensor),
  );
  const targetOptions = [
    { value: '', label: '（不跳转）' },
    ...blocks.map((block, index) => ({
      value: block.id,
      label: blockTitle(block, index),
    })),
  ];
  const variableOptions = inferVariableOptions(content);

  const patchBlock = (id: string, patch: Partial<SkillBlock>) => {
    if (readOnly) return;
    onChange({
      ...content,
      blocks: blocks.map((block) => (block.id === id ? { ...block, ...patch } : block)),
    });
  };

  const addBlock = (kind: SkillBlockKind) => {
    if (readOnly) return;
    const block = createBlock(kind, blocks.length);
    onChange({ ...content, blocks: [...blocks, block] });
  };

  const removeBlock = (id: string) => {
    if (readOnly) return;
    const target = blocks.find((block) => block.id === id);
    if (!target) return;
    const label = blockTitle(target, blocks.indexOf(target));
    if (!window.confirm(`删除块「${label}」？该块的条件分支连线也会一并移除`)) return;
    const rest = blocks.filter((block) => block.id !== id);
    onChange({
      entryBlockId: content.entryBlockId === id ? (rest[0]?.id ?? null) : content.entryBlockId,
      blocks: rest,
    });
  };

  const moveBlock = (index: number, delta: -1 | 1) => {
    const target = index + delta;
    if (target < 0 || target >= blocks.length) return;
    onChange({ ...content, blocks: arrayMove(blocks, index, target) });
  };

  const handleDragEnd = (event: DragEndEvent) => {
    const { active, over } = event;
    setDragging(false);
    if (!over || active.id === over.id) return;
    const from = blocks.findIndex((block) => block.id === active.id);
    const to = blocks.findIndex((block) => block.id === over.id);
    if (from < 0 || to < 0) return;
    onChange({ ...content, blocks: arrayMove(blocks, from, to) });
  };

  return (
    <DndContext
      sensors={sensors}
      collisionDetection={closestCenter}
      onDragStart={() => setDragging(true)}
      onDragCancel={() => setDragging(false)}
      onDragEnd={handleDragEnd}
    >
      <SortableContext items={blocks.map((block) => block.id)} strategy={verticalListSortingStrategy}>
        <div className={cn('flex flex-col gap-3', dragging && 'pointer-events-none select-none')}>
          {blocks.map((block, index) => (
            <SortableBlockCard
              key={block.id}
              block={block}
              index={index}
              total={blocks.length}
              isEntry={content.entryBlockId === block.id}
              targetOptions={targetOptions}
              variableOptions={variableOptions}
              readOnly={readOnly}
              onPatch={(patch) => patchBlock(block.id, patch)}
              onSetEntry={() => onChange({ ...content, entryBlockId: block.id })}
              onRemove={() => removeBlock(block.id)}
              onMove={(delta) => moveBlock(index, delta)}
            />
          ))}
        </div>
      </SortableContext>
      <div className="mt-3 flex items-center gap-2">
        {!readOnly ? (
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
                  label: BLOCK_KIND_META[option.value as SkillBlockKind].label,
                  onSelect: () => addBlock(option.value as SkillBlockKind),
                })),
              },
            ]}
          />
        ) : null}
        {readOnly ? (
          <span className="text-aux text-text-tertiary">默认技能只读，内容展示不可修改；可在技能库「复制」为自定义技能后编辑</span>
        ) : blocks.length === 0 ? (
          <span className="text-aux text-text-tertiary">还没有内容块，先添加一个</span>
        ) : (
          <span className="text-aux text-text-tertiary">拖动块左侧手柄可调整顺序</span>
        )}
      </div>
    </DndContext>
  );
}

interface BlockCardProps {
  block: SkillBlock;
  index: number;
  total: number;
  isEntry: boolean;
  targetOptions: { value: string; label: string }[];
  variableOptions: ReturnType<typeof inferVariableOptions>;
  readOnly?: boolean;
  onPatch: (patch: Partial<SkillBlock>) => void;
  onSetEntry: () => void;
  onRemove: () => void;
  onMove: (delta: -1 | 1) => void;
}

function SortableBlockCard(props: BlockCardProps) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: props.block.id,
    disabled: props.readOnly,
  });

  return (
    <div
      ref={setNodeRef}
      style={{ transform: CSS.Translate.toString(transform), transition }}
      className={cn(isDragging && 'z-10 opacity-80 shadow-pop')}
    >
      <BlockCard
        {...props}
        dragHandle={{
          attributes: attributes as unknown as React.HTMLAttributes<HTMLButtonElement>,
          listeners: (listeners ?? undefined) as unknown as React.HTMLAttributes<HTMLButtonElement> | undefined,
        }}
      />
    </div>
  );
}

function BlockCard({
  block,
  index,
  total,
  isEntry,
  targetOptions,
  variableOptions,
  readOnly = false,
  onPatch,
  onSetEntry,
  onRemove,
  onMove,
  dragHandle,
}: BlockCardProps & {
  dragHandle: {
    attributes: React.HTMLAttributes<HTMLButtonElement>;
    listeners: React.HTMLAttributes<HTMLButtonElement> | undefined;
  };
}) {
  const meta = BLOCK_KIND_META[block.kind];
  const Icon = meta.icon;

  /* 聚焦块卡片本体（tabIndex=0，而非内部输入框）时 Del/Backspace 删块，带确认。 */
  const handleKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
    if (event.target !== event.currentTarget) return;
    if (event.key === 'Delete' || event.key === 'Backspace') {
      event.preventDefault();
      onRemove();
    }
  };

  return (
    <div
      tabIndex={0}
      onKeyDown={handleKeyDown}
      aria-label={
        readOnly
          ? `块：${blockTitle(block, index)}`
          : `块：${blockTitle(block, index)}，聚焦后按 Delete 可删除`
      }
      className={cn(
        'rounded-card border bg-bg-surface p-3 shadow-card outline-none focus-visible:ring-2 focus-visible:ring-primary/40',
        isEntry ? 'border-primary' : 'border-border',
      )}
    >
      <div className="flex items-center gap-2">
        {!readOnly ? (
          <button
            type="button"
            aria-label="拖拽排序"
            className="cursor-grab touch-none text-text-tertiary hover:text-text-primary active:cursor-grabbing"
            {...dragHandle.attributes}
            {...dragHandle.listeners}
          >
            <GripVertical className="size-4" />
          </button>
        ) : null}
        <span className={cn('inline-flex items-center gap-1 rounded-tag px-1.5 py-0.5 text-badge', meta.kindClass)}>
          <Icon className="size-3.5" />
          {meta.label}
        </span>
        <Input
          value={block.title}
          placeholder={blockTitle(block, index)}
          className="h-7 flex-1 text-aux"
          disabled={readOnly}
          onChange={(event) => onPatch({ title: event.target.value })}
        />
        {!readOnly ? (
          <>
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
          </>
        ) : isEntry ? (
          <span className="rounded-badge bg-primary-light px-2 py-0.5 text-badge text-primary">入口</span>
        ) : null}
      </div>

      <div className="mt-3 flex flex-col gap-3">
        <BlockFields
          block={block}
          variableOptions={variableOptions}
          targetOptions={targetOptions}
          readOnly={readOnly}
          onPatch={onPatch}
        />
      </div>
    </div>
  );
}
