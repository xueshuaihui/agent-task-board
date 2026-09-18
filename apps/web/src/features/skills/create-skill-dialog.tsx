import { useState } from 'react';
import { Dialog, Field, Input, Select, Textarea } from '@/components/ui';
import { Button } from '@/components/ui';
import { SKILL_TYPE_META, SKILL_TYPE_OPTIONS, templateContent } from './meta';
import { useCreateSkill } from './hooks';
import type { Skill, SkillType } from './types';

/**
 * 新建技能（2.md 10.3 简化版：契约只收 name/type/description/tags/content）。
 * 创建成功即 v0.1.0 草稿，直接进入编辑器（onCreated 回调由页面接线）。
 */

export interface CreateSkillDialogProps {
  open: boolean;
  onClose: () => void;
  onCreated: (skill: Skill) => void;
}

export function CreateSkillDialog({ open, onClose, onCreated }: CreateSkillDialogProps) {
  const [name, setName] = useState('');
  const [type, setType] = useState<SkillType>('prompt');
  const [description, setDescription] = useState('');
  const [tagsText, setTagsText] = useState('');
  const [fromTemplate, setFromTemplate] = useState(true);

  const create = useCreateSkill((skill) => {
    setName('');
    setDescription('');
    setTagsText('');
    onClose();
    onCreated(skill);
  });

  const nameInvalid = open && name.trim().length === 0;

  return (
    <Dialog
      open={open}
      onClose={onClose}
      title="新建技能"
      footer={
        <>
          <Button variant="default" onClick={onClose}>
            取消
          </Button>
          <Button
            variant="primary"
            disabled={nameInvalid}
            loading={create.isPending}
            onClick={() =>
              create.mutate({
                name: name.trim(),
                type,
                description: description.trim(),
                tags: tagsText
                  .split(/[,，\s]+/)
                  .map((tag) => tag.trim())
                  .filter(Boolean),
                content: fromTemplate ? templateContent(type) : undefined,
              })
            }
          >
            创建
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-4">
        <Field label="技能名称" required error={nameInvalid ? '请输入名称' : undefined} htmlFor="skill-create-name">
          <Input
            id="skill-create-name"
            value={name}
            placeholder="code-review"
            onChange={(event) => setName(event.target.value)}
          />
        </Field>
        <Field label="类型" required hint={SKILL_TYPE_META[type].description}>
          <Select
            value={type}
            options={SKILL_TYPE_OPTIONS}
            onChange={(event) => setType(event.target.value as SkillType)}
          />
        </Field>
        <Field label="描述" htmlFor="skill-create-desc">
          <Textarea
            id="skill-create-desc"
            value={description}
            rows={3}
            placeholder="这个技能解决什么问题、怎么用"
            onChange={(event) => setDescription(event.target.value)}
          />
        </Field>
        <Field label="标签" hint="逗号或空格分隔">
          <Input
            value={tagsText}
            placeholder="review, quality"
            onChange={(event) => setTagsText(event.target.value)}
          />
        </Field>
        <Field label="起步内容">
          <label className="flex items-center gap-2 text-body text-text-primary">
            <input
              type="checkbox"
              checked={fromTemplate}
              onChange={(event) => setFromTemplate(event.target.checked)}
              className="accent-primary"
            />
            用该类型的模板块起步（可在编辑器中调整）
          </label>
        </Field>
      </div>
    </Dialog>
  );
}
