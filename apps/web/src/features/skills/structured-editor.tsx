import { Fragment, useState } from 'react';
import { ChevronDown, ChevronRight, ChevronUp, CornerUpLeft, Plus, Trash2 } from 'lucide-react';
import { Button, Input, Menu, Table, TBody, TD, TH, THead, TR } from '@/components/ui';
import { cn } from '@/lib/cn';
import { BLOCK_KIND_META, blockTitle, createBlock, inferVariableOptions } from './meta';
import { BlockFields } from './block-fields';
import type { SkillBlock, SkillBlockKind, SkillContent } from './types';

/**
 * 结构化模式（1.md 8.3，进阶用户）：blocks 的表格式编辑。
 * 每行 = 一个块（类型 / 标题 / 关键字段摘要 + 操作列），点击行展开行内编辑完整
 * 字段（与可视化模式共用 block-fields.tsx 的表单）。支持上移/下移/删除/在下方插入，
 * 比可视化模式更紧凑，适合批量过一遍块列表。
 */

const KIND_OPTIONS = (Object.keys(BLOCK_KIND_META) as SkillBlockKind[]).map((kind) => ({
  value: kind,
  label: BLOCK_KIND_META[kind].label,
}));

export interface StructuredEditorProps {
  content: SkillContent;
  onChange: (next: SkillContent) => void;
  /** W3 §9.1：默认技能只读——操作列/插入按钮隐藏，展开行为只读字段。 */
  readOnly?: boolean;
}

export function StructuredEditor({ content, onChange, readOnly = false }: StructuredEditorProps) {
  const blocks = content.blocks;
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const targetOptions = [
    { value: '', label: '（不跳转）' },
    ...blocks.map((block, index) => ({ value: block.id, label: blockTitle(block, index) })),
  ];
  const variableOptions = inferVariableOptions(content);

  const patchBlock = (id: string, patch: Partial<SkillBlock>) => {
    if (readOnly) return;
    onChange({
      ...content,
      blocks: blocks.map((block) => (block.id === id ? { ...block, ...patch } : block)),
    });
  };

  const addBlock = (kind: SkillBlockKind, afterId?: string) => {
    if (readOnly) return;
    const block = createBlock(kind, blocks.length);
    if (afterId) {
      const index = blocks.findIndex((item) => item.id === afterId);
      const next = [...blocks];
      next.splice(index + 1, 0, block);
      onChange({ ...content, blocks: next });
    } else {
      onChange({ ...content, blocks: [...blocks, block] });
    }
    setExpandedId(block.id);
  };

  const removeBlock = (id: string) => {
    if (readOnly) return;
    const rest = blocks.filter((block) => block.id !== id);
    onChange({
      entryBlockId: content.entryBlockId === id ? (rest[0]?.id ?? null) : content.entryBlockId,
      blocks: rest,
    });
    if (expandedId === id) setExpandedId(null);
  };

  const moveBlock = (index: number, delta: -1 | 1) => {
    if (readOnly) return;
    const target = index + delta;
    if (target < 0 || target >= blocks.length) return;
    const next = [...blocks];
    [next[index], next[target]] = [next[target], next[index]];
    onChange({ ...content, blocks: next });
  };

  return (
    <div className="flex flex-col gap-3">
      <div className="rounded-card border border-border bg-bg-surface shadow-card">
        <Table>
          <THead>
            <TR>
              <TH className="w-24">类型</TH>
              <TH>标题</TH>
              <TH className="hidden md:table-cell">关键字段摘要</TH>
              <TH className="w-16 text-center">入口</TH>
              {!readOnly ? <TH className="w-36 text-right">操作</TH> : null}
            </TR>
          </THead>
          <TBody>
            {blocks.map((block, index) => {
              const meta = BLOCK_KIND_META[block.kind];
              const Icon = meta.icon;
              const expanded = expandedId === block.id;
              return (
                <Fragment key={block.id}>
                  <TR
                    className={cn('cursor-pointer', expanded && 'bg-bg-raised')}
                    onClick={() => setExpandedId(expanded ? null : block.id)}
                  >
                    <TD>
                      <span className={cn('inline-flex items-center gap-1 rounded-tag px-1.5 py-0.5 text-badge', meta.kindClass)}>
                        <Icon className="size-3.5" />
                        {meta.label}
                      </span>
                    </TD>
                    <TD>
                      <span className="flex items-center gap-1.5">
                        {expanded ? <ChevronDown className="size-3.5 text-text-tertiary" /> : <ChevronRight className="size-3.5 text-text-tertiary" />}
                        <span className="truncate text-body">{block.title || `${meta.label} ${index + 1}`}</span>
                      </span>
                    </TD>
                    <TD className="hidden max-w-0 md:table-cell">
                      <span className="block truncate text-aux text-text-tertiary">{meta.summary(block)}</span>
                    </TD>
                    <TD className="text-center">
                      {content.entryBlockId === block.id ? (
                        <CornerUpLeft className="ml-auto mr-auto size-3.5 text-primary" aria-label="入口块" />
                      ) : null}
                    </TD>
                    {!readOnly ? (
                      <TD>
                        <div className="flex items-center justify-end gap-0.5" onClick={(event) => event.stopPropagation()}>
                        <Button
                          variant="ghost"
                          size="iconSm"
                          aria-label="设为入口"
                          disabled={content.entryBlockId === block.id}
                          onClick={() => onChange({ ...content, entryBlockId: block.id })}
                        >
                          <CornerUpLeft className="size-3.5" />
                        </Button>
                        <Button variant="ghost" size="iconSm" aria-label="上移" disabled={index === 0} onClick={() => moveBlock(index, -1)}>
                          <ChevronUp className="size-4" />
                        </Button>
                        <Button
                          variant="ghost"
                          size="iconSm"
                          aria-label="下移"
                          disabled={index === blocks.length - 1}
                          onClick={() => moveBlock(index, 1)}
                        >
                          <ChevronDown className="size-4" />
                        </Button>
                        <Menu
                          width={160}
                          align="end"
                          trigger={({ toggle }) => (
                            <Button variant="ghost" size="iconSm" aria-label="在下方插入块" onClick={toggle}>
                              <Plus className="size-4" />
                            </Button>
                          )}
                          groups={[
                            {
                              items: KIND_OPTIONS.map((option) => ({
                                id: option.value,
                                label: option.label,
                                onSelect: () => addBlock(option.value as SkillBlockKind, block.id),
                              })),
                            },
                          ]}
                        />
                        <Button variant="ghost" size="iconSm" aria-label="删除块" onClick={() => removeBlock(block.id)}>
                          <Trash2 className="size-4" />
                        </Button>
                        </div>
                      </TD>
                    ) : null}
                  </TR>
                  {expanded ? (
                    <TR>
                      <TD colSpan={readOnly ? 4 : 5} className="bg-bg-raised">
                        <div className="p-3">
                          <div className="mb-3 flex items-center gap-2">
                            <Input
                              value={block.title}
                              placeholder={`${meta.label} ${index + 1}`}
                              className="h-7 w-64 text-aux"
                              disabled={readOnly}
                              onChange={(event) => patchBlock(block.id, { title: event.target.value })}
                            />
                          </div>
                          <BlockFields
                            block={block}
                            variableOptions={variableOptions}
                            targetOptions={targetOptions}
                            readOnly={readOnly}
                            onPatch={(patch) => patchBlock(block.id, patch)}
                          />
                        </div>
                      </TD>
                    </TR>
                  ) : null}
                </Fragment>
              );
            })}
            {blocks.length === 0 ? (
              <TR>
                <TD colSpan={readOnly ? 4 : 5} className="text-center text-aux text-text-tertiary">
                  {readOnly ? '默认技能没有内容块' : '还没有内容块，用下方按钮添加'}
                </TD>
              </TR>
            ) : null}
          </TBody>
        </Table>
      </div>
      {!readOnly ? (
        <Menu
          width={180}
          trigger={({ toggle }) => (
            <Button size="sm" icon={<Plus className="size-4" />} onClick={toggle} className="self-start">
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
      ) : (
        <p className="text-aux text-text-tertiary">默认技能只读：点击行可展开查看块字段，不可修改</p>
      )}
    </div>
  );
}
