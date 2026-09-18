import { Plus, Trash2 } from 'lucide-react';
import { Button, Field, Input, Switch, Textarea } from '@/components/ui';
import { cn } from '@/lib/cn';
import type { SkillMcpDependency } from './types';

/**
 * MCP 依赖声明编辑器（2.md 11.3 发布对话框内）：server / tools（逗号分隔）/
 * required 开关 / reason。发的是随版本提交的 `mcp_dependencies`（契约补充，
 * 后端在 POST /versions 里收，见 README「契约补充」）。
 */

export interface McpDependencyEditorProps {
  value: SkillMcpDependency[];
  onChange: (next: SkillMcpDependency[]) => void;
  className?: string;
}

export function McpDependencyEditor({ value, onChange, className }: McpDependencyEditorProps) {
  const update = (index: number, patch: Partial<SkillMcpDependency>) => {
    onChange(value.map((item, i) => (i === index ? { ...item, ...patch } : item)));
  };

  return (
    <div className={cn('flex flex-col gap-3', className)}>
      {value.map((item, index) => (
        <div key={index} className="rounded-card border border-border bg-bg-raised p-3">
          <div className="mb-2 flex items-center justify-between">
            <p className="text-card-title text-text-secondary">依赖 {index + 1}</p>
            <Button
              variant="ghost"
              size="iconSm"
              aria-label="删除依赖"
              onClick={() => onChange(value.filter((_, i) => i !== index))}
            >
              <Trash2 className="size-4" />
            </Button>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <Field label="MCP Server">
              <Input
                value={item.server}
                placeholder="github"
                onChange={(event) => update(index, { server: event.target.value })}
              />
            </Field>
            <Field label="工具（逗号分隔）">
              <Input
                value={item.tools.join(', ')}
                placeholder="get_pull_request, create_review"
                onChange={(event) =>
                  update(index, {
                    tools: event.target.value
                      .split(/[,，]/)
                      .map((tool) => tool.trim())
                      .filter(Boolean),
                  })
                }
              />
            </Field>
          </div>
          <div className="mt-3 flex items-start gap-6">
            <label className="flex shrink-0 items-center gap-2 text-body text-text-primary">
              <Switch
                checked={item.required}
                onChange={(checked) => update(index, { required: checked })}
              />
              必需
            </label>
            <Field label="用途说明" className="flex-1">
              <Textarea
                value={item.reason ?? ''}
                rows={2}
                placeholder="为什么需要这个依赖"
                onChange={(event) => update(index, { reason: event.target.value })}
              />
            </Field>
          </div>
        </div>
      ))}
      <Button
        variant="default"
        icon={<Plus className="size-4" />}
        className="self-start"
        onClick={() =>
          onChange([...value, { server: '', tools: [], required: true, reason: '' }])
        }
      >
        添加依赖
      </Button>
    </div>
  );
}
