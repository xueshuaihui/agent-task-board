import { ChevronDown } from 'lucide-react';
import { useState } from 'react';
import { cn } from '@/lib/cn';
import { Badge, Field, Input, Menu, Select, Textarea, type MenuGroup } from '@/components/ui';
import { ON_ERROR_META, PARALLEL_MERGE_META, SKILL_ORIGIN_META, UNCATEGORIZED_LABEL, VALUE_TYPE_OPTIONS } from './meta';
import { useSkills } from './hooks';
import type { OnError, ParallelMerge, Skill, SkillBlock } from './types';
import { VariableTextarea, type VariableMenuProps } from './variable-picker';

/**
 * 单个块的字段表单（可视化模式卡片体与结构化模式展开行共用）。
 * 按 kind 渲染对应字段（1.md 8.3 PRD 15 类），文本字段旁带变量插入下拉。
 */

const PARALLEL_MERGE_OPTIONS = (Object.keys(PARALLEL_MERGE_META) as ParallelMerge[]).map((value) => ({
  value,
  label: PARALLEL_MERGE_META[value].label,
}));

const ON_ERROR_OPTIONS = (Object.keys(ON_ERROR_META) as OnError[]).map((value) => ({
  value,
  label: ON_ERROR_META[value].label,
}));

export interface BlockFieldsProps {
  block: SkillBlock;
  /** 变量插入的可选项（由页面用 inferVariableOptions 推断后传入）。 */
  variableOptions: VariableMenuProps['options'];
  /** decision 分支跳转的目标块下拉选项。 */
  targetOptions: { value: string; label: string }[];
  /** W3 §9.1 只读态：fieldset disabled 统一禁掉块内全部输入控件与变量/分支按钮。 */
  readOnly?: boolean;
  onPatch: (patch: Partial<SkillBlock>) => void;
}

export function BlockFields({ block, variableOptions, targetOptions, readOnly = false, onPatch }: BlockFieldsProps) {
  return <fieldset disabled={readOnly} className="contents">{renderFields()}</fieldset>;

  function renderFields() {
    switch (block.kind) {
    case 'prompt':
    case 'knowledge':
      return (
        <Field label={block.kind === 'prompt' ? '提示词内容' : '知识引用内容'} hint="可用 {{input.x}}、{{prev.output}} 等变量">
          <VariableTextarea
            value={block.prompt ?? ''}
            rows={4}
            options={variableOptions}
            onChange={(value) => onPatch({ prompt: value })}
          />
        </Field>
      );

    case 'step':
      return (
        <Field label="步骤列表" hint="每行一步">
          <Textarea
            value={(block.steps ?? []).join('\n')}
            rows={4}
            onChange={(event) => onPatch({ steps: event.target.value.split('\n').map((line) => line.trimEnd()) })}
          />
        </Field>
      );

    case 'decision':
      return (
        <>
          <Field label="判断条件">
            <VariableTextarea
              value={block.condition ?? ''}
              rows={2}
              options={variableOptions}
              placeholder="例如：测试是否全部通过"
              onChange={(value) => onPatch({ condition: value })}
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
              </div>
            ))}
            <button
              type="button"
              className="self-start text-aux text-text-tertiary underline-offset-2 hover:text-text-secondary hover:underline"
              onClick={() => onPatch({ next: [...(block.next ?? []), { when: '', to: '' }] })}
            >
              + 添加分支
            </button>
          </div>
        </>
      );

    case 'loop':
      return (
        <>
          <Field label="循环条件（while）" hint="为空表示按步骤顺序执行一次">
            <VariableTextarea
              value={block.while ?? ''}
              rows={2}
              options={variableOptions}
              placeholder="例如：{{input.paths}} 还有未处理的项"
              onChange={(value) => onPatch({ while: value })}
            />
          </Field>
          <Field label="循环体步骤" hint="每行一步（简表）">
            <Textarea
              value={(block.steps ?? []).join('\n')}
              rows={3}
              onChange={(event) => onPatch({ steps: event.target.value.split('\n').map((line) => line.trimEnd()) })}
            />
          </Field>
        </>
      );

    case 'parallel':
      return (
        <>
          <Field label="合并策略">
            <Select
              value={block.merge ?? 'all'}
              options={PARALLEL_MERGE_OPTIONS}
              onChange={(event) => onPatch({ merge: event.target.value as ParallelMerge })}
            />
          </Field>
          <Field label="并行分支" hint="每行一个分支的描述">
            <Textarea
              value={(block.branches ?? []).join('\n')}
              rows={3}
              onChange={(event) => onPatch({ branches: event.target.value.split('\n').map((line) => line.trimEnd()) })}
            />
          </Field>
        </>
      );

    case 'tool':
      return (
        <>
          <div className="flex gap-3">
            <Field label="MCP Server" className="flex-1" hint="需与发布时的 MCP 依赖声明一致">
              <Input value={block.server ?? ''} placeholder="github" onChange={(event) => onPatch({ server: event.target.value })} />
            </Field>
            <Field label="工具名" className="flex-1">
              <Input value={block.tool ?? ''} placeholder="get_pull_request" onChange={(event) => onPatch({ tool: event.target.value })} />
            </Field>
          </div>
          <Field label="参数模板" hint="JSON 模板，支持 {{变量}}">
            <VariableTextarea
              value={block.argsTemplate ?? ''}
              rows={3}
              className="font-mono"
              options={variableOptions}
              placeholder='{"pr": {{task.number}}}'
              onChange={(value) => onPatch({ argsTemplate: value })}
            />
          </Field>
        </>
      );

    case 'script':
      return (
        <Field label="脚本">
          <Textarea value={block.script ?? ''} rows={5} className="font-mono" onChange={(event) => onPatch({ script: event.target.value })} />
        </Field>
      );

    case 'subskill':
      return <SubskillField block={block} onPatch={onPatch} />;

    case 'human':
      return (
        <Field label="人工指引" hint="执行到该块时任务进入 BLOCKED，等待人工输入">
          <VariableTextarea
            value={block.humanInstruction ?? ''}
            rows={3}
            options={variableOptions}
            onChange={(value) => onPatch({ humanInstruction: value })}
          />
        </Field>
      );

    case 'input':
    case 'output':
      return (
        <div className="flex gap-3">
          <Field label="变量名" className="flex-1">
            <Input
              value={block.name ?? ''}
              placeholder={block.kind === 'input' ? 'diff' : 'report'}
              onChange={(event) => onPatch({ name: event.target.value })}
            />
          </Field>
          <Field label="类型" className="w-40">
            <Select
              value={block.valueType ?? 'string'}
              options={VALUE_TYPE_OPTIONS}
              onChange={(event) => onPatch({ valueType: event.target.value })}
            />
          </Field>
          <Field label="必填" className="w-20">
            <Select
              value={block.required ? 'yes' : 'no'}
              options={[
                { value: 'yes', label: '是' },
                { value: 'no', label: '否' },
              ]}
              onChange={(event) => onPatch({ required: event.target.value === 'yes' })}
            />
          </Field>
        </div>
      );

    case 'constraint':
      return (
        <Field label="规则" hint="Agent 必须遵守的硬性约束">
          <VariableTextarea value={block.rule ?? ''} rows={2} options={variableOptions} onChange={(value) => onPatch({ rule: value })} />
        </Field>
      );

    case 'error_handler':
      return (
        <div className="flex gap-3">
          <Field label="失败策略" className="flex-1">
            <Select
              value={block.onError ?? 'abort'}
              options={ON_ERROR_OPTIONS}
              onChange={(event) => onPatch({ onError: event.target.value as OnError })}
            />
          </Field>
          {block.onError === 'retry' ? (
            <Field label="重试次数" className="w-32">
              <Input
                type="number"
                value={block.retryCount ?? 3}
                min={1}
                onChange={(event) => onPatch({ retryCount: Number(event.target.value) })}
              />
            </Field>
          ) : null}
          <Field label="超时 (ms)" className="w-36" hint="留空不限">
            <Input
              type="number"
              value={block.timeoutMs ?? ''}
              onChange={(event) => onPatch({ timeoutMs: event.target.value ? Number(event.target.value) : undefined })}
            />
          </Field>
        </div>
      );

    case 'comment':
      return (
        <Field label="说明" hint="仅说明用途，不参与执行">
          <Textarea value={block.note ?? ''} rows={2} onChange={(event) => onPatch({ note: event.target.value })} />
        </Field>
      );
    }
  }
}

/**
 * 子技能块字段（W3 §9.4/§7 智能辅助「技能插入」）：从技能库（GET /skills 存量）
 * 下拉选择，按唯一 id 写入块载荷 `skillRef`（§9.2 r2：绑定/下发一律按 id，
 * content 是 passthrough JSON，版本快照/导出 .atskill/SKILL.md 天然兼容）。
 * 分组轴为分类（直读 skill.category 真列，PRD §9.2 单值词表；'' 归「未分类」且恒排最后）；
 * 行尾小徽标只剩非默认来源注记（官方/社区 受众词已作废，出处由 source_type 承载）。
 * 重名技能追加 id 后 6 位消歧后缀（§9.2 r2 允许重名，与技能卡片同口径）。
 * 技能库空/加载中退回手填 id 输入框。
 * W3 遗留①：列表顶部提供名称搜索框，大小写不敏感子串过滤，保留分组与消歧口径；
 * 无匹配时渲染「无匹配技能」禁用态。
 */
function SubskillField({
  block,
  onPatch,
}: {
  block: SkillBlock;
  onPatch: (patch: Partial<SkillBlock>) => void;
}) {
  const skills = useSkills();
  const [query, setQuery] = useState('');
  const items = skills.data?.items ?? [];
  if (items.length === 0) {
    return (
      <Field label="引用技能" hint="子技能的 id（如 skl_xxx），发布前请确认目标技能可用">
        <Input value={block.skillRef ?? ''} placeholder="skl_xxx" onChange={(event) => onPatch({ skillRef: event.target.value })} />
      </Field>
    );
  }
  // r2 允许重名：同名集合基于全量列表统计，保证过滤前后消歧后缀口径一致。
  const nameCount = new Map<string, number>();
  for (const skill of items) nameCount.set(skill.name, (nameCount.get(skill.name) ?? 0) + 1);
  const needle = query.trim().toLowerCase();
  const visible = needle ? items.filter((skill) => skill.name.toLowerCase().includes(needle)) : items;
  const selected = items.find((skill) => skill.id === block.skillRef);
  // 分组轴 = skill.category 真列直读；''（未分类）归「未分类」组。
  const byCategory = new Map<string, Skill[]>();
  for (const skill of visible) {
    const label = skill.category || UNCATEGORIZED_LABEL;
    const bucket = byCategory.get(label);
    if (bucket) bucket.push(skill);
    else byCategory.set(label, [skill]);
  }
  const groups: { label: string; skills: Skill[] }[] = [...byCategory.entries()]
    .sort((a, b) => {
      if (a[0] === UNCATEGORIZED_LABEL) return 1;
      if (b[0] === UNCATEGORIZED_LABEL) return -1;
      return b[1].length - a[1].length || a[0].localeCompare(b[0]);
    })
    .map(([label, skills]) => ({ label: `${label}（${skills.length}）`, skills }));
  const menuGroups: MenuGroup[] = groups.map((group) => ({
    label: group.label,
    items: group.skills.map((skill) => ({
      id: skill.id,
      label: <SkillRefOption skill={skill} duplicateName={(nameCount.get(skill.name) ?? 0) > 1} />,
      onSelect: () => onPatch({ skillRef: skill.id }),
    })),
  }));
  if (menuGroups.length === 0) {
    menuGroups.push({
      label: '搜索结果',
      items: [{ id: '__no-match', disabled: true, label: <span className="text-text-tertiary">无匹配技能「{query.trim()}」</span> }],
    });
  }
  if (block.skillRef && !selected) {
    menuGroups.unshift({
      label: '技能库外引用',
      items: [{ id: block.skillRef, disabled: true, label: <span className="truncate text-text-secondary">{block.skillRef}（不在技能库）</span> }],
    });
  }
  menuGroups.push({
    label: ' ',
    items: [{ id: '__clear', label: '（清除引用）', onSelect: () => onPatch({ skillRef: '' }) }],
  });
  return (
    <Field label="引用技能" hint="从技能库选择子技能，按唯一 id 绑定；按分类分组，行尾徽标为非默认来源注记">
      <div className="flex flex-col gap-1.5">
        <Input
          value={query}
          placeholder="搜索技能名称…"
          aria-label="搜索技能名称"
          className="h-7 text-aux"
          onChange={(event) => setQuery(event.target.value)}
        />
        <Menu
          width={300}
          selectedId={selected ? selected.id : block.skillRef}
          groups={menuGroups}
          trigger={() => (
            <button
              type="button"
              className={cn(
                'flex h-8 w-full items-center justify-between gap-2 rounded-control border border-border bg-bg-raised px-3 text-left text-body text-text-primary',
                'transition-colors duration-140 ease-settle hover:border-border-strong',
                'focus:border-primary focus:outline-none focus:ring-2 focus:ring-primary-ring',
                'disabled:cursor-not-allowed disabled:opacity-60',
              )}
            >
              {selected ? (
                <SkillRefOption skill={selected} duplicateName={(nameCount.get(selected.name) ?? 0) > 1} />
              ) : (
                <span className="min-w-0 flex-1 truncate text-text-tertiary">
                  {block.skillRef ? `${block.skillRef}（不在技能库）` : '（选择子技能）'}
                </span>
              )}
              <ChevronDown className="pointer-events-none size-4 shrink-0 text-text-tertiary" />
            </button>
          )}
        />
      </div>
    </Field>
  );
}

/**
 * 技能选项行：名称（重名带 ·id 后 6 位消歧）+ 行尾小徽标（非默认来源注记；
 * 官方/社区 受众词已作废，默认技能行尾无徽标）+ 版本。分类由组头承载，不再逐行展示。
 */
function SkillRefOption({ skill, duplicateName }: { skill: Skill; duplicateName: boolean }) {
  const origin = SKILL_ORIGIN_META[skill.source];
  const annotation = skill.source === 'default' ? '' : origin.label;
  return (
    <span className="flex min-w-0 flex-1 items-center gap-1.5">
      <span className="truncate" title={skill.name}>
        {duplicateName ? `${skill.name} ·${skill.id.slice(-6)}` : skill.name}
      </span>
      {annotation ? (
        <Badge tone="neutral" className="max-w-[120px] shrink-0">
          {annotation}
        </Badge>
      ) : null}
      <span className="ml-auto shrink-0 tabular-nums text-aux text-text-tertiary">{skill.current_version}</span>
    </span>
  );
}
