import { Field, Input, Select, Textarea } from '@/components/ui';
import { ON_ERROR_META, PARALLEL_MERGE_META, VALUE_TYPE_OPTIONS } from './meta';
import type { OnError, ParallelMerge, SkillBlock } from './types';
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
  onPatch: (patch: Partial<SkillBlock>) => void;
}

export function BlockFields({ block, variableOptions, targetOptions, onPatch }: BlockFieldsProps) {
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
      return (
        <Field label="引用技能" hint="子技能的 id（如 skl_xxx），发布前请确认目标技能可用">
          <Input value={block.skillRef ?? ''} placeholder="skl_xxx" onChange={(event) => onPatch({ skillRef: event.target.value })} />
        </Field>
      );

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
