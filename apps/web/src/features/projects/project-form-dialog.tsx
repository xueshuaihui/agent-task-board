import { useState, type FormEvent } from 'react';
import { fieldErrorsOf, isApiError } from '@/api';
import { errorMessage } from '@/api/errors';
import { useToast } from '@/components/ui';
import { Button, Dialog, Field, Input, Textarea } from '@/components/ui';
import { cn } from '@/lib/cn';
import { useProjectMutations } from './queries';
import type { Project, ProjectCreateInput, ProjectPatchInput } from './types';

/**
 * 5.2 新建/编辑项目对话框。颜色与图标的口径：
 * - 颜色从现有状态色 token 调色板里选（`COLOR_OPTIONS`），不引第二套色；
 * - 图标是简单 emoji 单选（7.8 的 📁 语义），超出候选时保留原值原样显示。
 */

/** 取自 globals.css `@theme` 的状态色（1.1），作为项目标识色。 */
export const COLOR_OPTIONS: readonly { value: string; label: string }[] = [
  { value: '#5a51e8', label: '主色' },
  { value: '#3b82f6', label: '蓝' },
  { value: '#8b5cf6', label: '紫' },
  { value: '#f59e0b', label: '橙' },
  { value: '#10b981', label: '绿' },
  { value: '#ef4444', label: '红' },
  { value: '#0891b2', label: '青' },
  { value: '#6b7280', label: '灰' },
];

/** 原型 7.8 的 📁 加常用项目语义，8 个封顶——图标是锦上添花，不是必填。 */
export const ICON_OPTIONS: readonly string[] = ['📁', '🚀', '🛠️', '📊', '🧪', '🎨', '💼', '🌐'];

export interface ProjectFormDialogProps {
  /** 传 null = 新建；传项目 = 编辑。 */
  project: Project | null;
  onClose: () => void;
}

export function ProjectFormDialog({ project, onClose }: ProjectFormDialogProps) {
  const editing = project !== null;
  const title = editing ? `编辑项目：${project.name}` : '新建项目';

  return (
    <Dialog open size="form" title={title} onClose={onClose}>
      <ProjectForm project={project} onClose={onClose} />
    </Dialog>
  );
}

function ProjectForm({ project, onClose }: { project: Project | null; onClose: () => void }) {
  const toast = useToast();
  const mutations = useProjectMutations();
  const editing = project !== null;

  const [name, setName] = useState(project?.name ?? '');
  const [color, setColor] = useState(project?.color ?? COLOR_OPTIONS[0].value);
  const [icon, setIcon] = useState(project?.icon ?? '📁');
  const [description, setDescription] = useState(project?.description ?? '');
  const [errors, setErrors] = useState<Record<string, string>>({});

  const busy = mutations.create.isPending || mutations.patch.isPending;

  const submit = async (event?: FormEvent) => {
    event?.preventDefault();
    setErrors({});
    const trimmed = name.trim();
    if (!trimmed) {
      setErrors({ name: '项目名称不能为空' });
      return;
    }
    try {
      if (editing && project) {
        const body: ProjectPatchInput = {};
        if (trimmed !== project.name) body.name = trimmed;
        if (color !== project.color) body.color = color;
        if (icon !== project.icon) body.icon = icon || null;
        if (description.trim() !== (project.description ?? '')) {
          body.description = description.trim() === '' ? null : description.trim();
        }
        if (Object.keys(body).length === 0) {
          onClose();
          return;
        }
        await mutations.patch.mutateAsync({ id: project.id, body });
        toast.success('项目已更新', project.name);
      } else {
        const body: ProjectCreateInput = {
          name: trimmed,
          color,
          ...(icon ? { icon } : {}),
          ...(description.trim() ? { description: description.trim() } : {}),
        };
        const created = await mutations.create.mutateAsync(body);
        toast.success('项目已创建', created.name);
      }
      onClose();
    } catch (error) {
      if (isApiError(error) && error.code === 'VALIDATION_FAILED') {
        const issues = fieldErrorsOf(error);
        setErrors(issues);
        toast.warning(error.message, Object.values(issues).slice(0, 3).join('；'));
        return;
      }
      toast.error(errorMessage(error));
    }
  };

  return (
    <form className="flex flex-col gap-3" onSubmit={submit}>
      <Field label="项目名称" required error={errors.name}>
        <Input
          value={name}
          invalid={Boolean(errors.name)}
          autoFocus
          maxLength={50}
          placeholder="例如：电商平台"
          onChange={(event) => setName(event.target.value)}
        />
      </Field>

      <Field label="标识颜色" hint="从现有状态色板选取（1.1 token）">
        <div role="radiogroup" aria-label="标识颜色" className="flex flex-wrap items-center gap-2">
          {COLOR_OPTIONS.map((option) => (
            <button
              key={option.value}
              type="button"
              role="radio"
              aria-checked={color === option.value}
              title={option.label}
              onClick={() => setColor(option.value)}
              className={cn(
                'inline-flex size-7 items-center justify-center rounded-full border-2 transition-colors duration-120 ease-out',
                color === option.value ? 'border-primary' : 'border-transparent hover:border-border-strong',
              )}
            >
              <span className="size-4 rounded-full" style={{ backgroundColor: option.value }} aria-hidden />
            </button>
          ))}
        </div>
      </Field>

      <Field label="图标" hint="可选">
        <div role="radiogroup" aria-label="图标" className="flex flex-wrap items-center gap-1">
          {ICON_OPTIONS.map((option) => (
            <button
              key={option}
              type="button"
              role="radio"
              aria-checked={icon === option}
              onClick={() => setIcon(option)}
              className={cn(
                'inline-flex size-8 items-center justify-center rounded-control border text-body transition-colors duration-120 ease-out',
                icon === option
                  ? 'border-primary bg-primary-light'
                  : 'border-transparent hover:bg-bg-muted',
              )}
            >
              {option}
            </button>
          ))}
        </div>
      </Field>

      <Field label="描述" hint="可选，说明这个项目装什么">
        <Textarea
          rows={2}
          value={description}
          maxLength={2000}
          placeholder="例如：电商平台核心业务"
          onChange={(event) => setDescription(event.target.value)}
        />
      </Field>

      <div className="flex items-center justify-end gap-2 pt-1">
        <Button variant="ghost" onClick={onClose}>
          取消
        </Button>
        <Button variant="primary" loading={busy} onClick={() => void submit()}>
          {editing ? '保存' : '创建'}
        </Button>
      </div>
    </form>
  );
}
