import { useEffect, useMemo, useRef, useState } from 'react';
import { ArrowLeft, ArrowRight, Sparkles } from 'lucide-react';
import { Button, Dialog, Field, Input, RadioGroup, Select, Textarea } from '@/components/ui';
import { cn } from '@/lib/cn';
import {
  SKILL_CATEGORY_OPTIONS,
  SKILL_STARTER_TEMPLATES,
  SKILL_TYPE_META,
  SKILL_TYPE_OPTIONS,
  UNCATEGORIZED_CATEGORY,
  templateContent,
} from './meta';
import { useCreateSkill } from './hooks';
import type { Skill, SkillCategoryOrNone, SkillType } from './types';

/**
 * 新建技能向导（两步，2.md 10.3 打磨版）：
 * ① 名称 + 类型 + 起步方式（空白 / 从模板起步，列出 8 个内置模板摘要）；
 * ② 可选的描述与标签 + 分类单选（11 词表 + 未分类，PRD §9.2 真字段）。
 * 第一步默认聚焦名称，Enter 前进；第二步 Enter 提交。
 * 创建成功即 v0.1.0 草稿，onCreated 由页面接进编辑器（?edit= 链路）。
 */

export interface CreateSkillDialogProps {
  open: boolean;
  onClose: () => void;
  onCreated: (skill: Skill) => void;
  /** 外部入口预选：模板菜单点进来时直接带模板 id。 */
  initialTemplateId?: string | null;
  /** 从模板预选带进来的类型。 */
  initialType?: SkillType;
}

export function CreateSkillDialog({
  open,
  onClose,
  onCreated,
  initialTemplateId,
  initialType,
}: CreateSkillDialogProps) {
  const [step, setStep] = useState<1 | 2>(1);
  const [name, setName] = useState('');
  const [type, setType] = useState<SkillType>(initialType ?? 'prompt');
  const [templateId, setTemplateId] = useState<string | null>(initialTemplateId ?? null);
  const [description, setDescription] = useState('');
  const [tagsText, setTagsText] = useState('');
  const [category, setCategory] = useState<SkillCategoryOrNone>(UNCATEGORIZED_CATEGORY);
  const nameRef = useRef<HTMLInputElement>(null);

  /* 打开时按外部入口重置，并聚焦名称字段。分类：空白默认未分类，
     外部带了模板 id 时用模板自带分类预填。 */
  useEffect(() => {
    if (!open) return;
    setStep(1);
    setName('');
    setDescription('');
    setTagsText('');
    setType(initialType ?? 'prompt');
    setTemplateId(initialTemplateId ?? null);
    const initialCategory =
      SKILL_STARTER_TEMPLATES.find((item) => item.id === initialTemplateId)?.category ??
      UNCATEGORIZED_CATEGORY;
    setCategory(initialCategory);
    const timer = window.setTimeout(() => nameRef.current?.focus(), 80);
    return () => window.clearTimeout(timer);
  }, [open, initialTemplateId, initialType]);

  const template = useMemo(
    () => SKILL_STARTER_TEMPLATES.find((item) => item.id === templateId) ?? null,
    [templateId],
  );

  const nameInvalid = open && name.trim().length === 0;
  const canNext = name.trim().length > 0;

  const create = useCreateSkill((skill) => {
    onClose();
    onCreated(skill);
  });

  const submit = () => {
    if (!canNext || create.isPending) return;
    /* 选了模板用模板内容；空白起步给该类型的模板块（prompt 只有一个入口块）。 */
    const content = template ? template.content : templateContent(type);
    const finalDescription = description.trim() || template?.description || '';
    const finalTags = tagsText
      .split(/[,，\s]+/)
      .map((tag) => tag.trim())
      .filter(Boolean);
    create.mutate({
      name: name.trim(),
      type: template?.type ?? type,
      description: finalDescription,
      tags: finalTags.length > 0 ? finalTags : (template?.tags ?? []),
      category,
      content,
    });
  };

  const handleKeyDown = (event: React.KeyboardEvent) => {
    if (event.key !== 'Enter' || event.shiftKey) return;
    event.preventDefault();
    if (step === 1) {
      if (canNext) setStep(2);
      return;
    }
    submit();
  };

  return (
    <Dialog
      open={open}
      onClose={onClose}
      title={
        <span className="flex items-center gap-2">
          新建技能
          <span className="text-aux text-text-tertiary">第 {step} / 2 步</span>
        </span>
      }
      footer={
        step === 1 ? (
          <>
            <Button variant="default" onClick={onClose}>
              取消
            </Button>
            <Button variant="primary" disabled={!canNext} onClick={() => setStep(2)}>
              下一步
              <ArrowRight className="size-4" />
            </Button>
          </>
        ) : (
          <>
            <Button variant="ghost" icon={<ArrowLeft className="size-4" />} onClick={() => setStep(1)}>
              上一步
            </Button>
            <Button variant="primary" loading={create.isPending} onClick={submit}>
              创建并进入编辑器
            </Button>
          </>
        )
      }
    >
      <div onKeyDown={handleKeyDown}>
        {step === 1 ? (
          <div className="flex flex-col gap-4">
            <Field
              label="技能名称"
              required
              error={nameInvalid ? '请输入名称' : undefined}
              htmlFor="skill-create-name"
            >
              <Input
                id="skill-create-name"
                ref={nameRef}
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
            <Field label="起步方式" hint="模板只提供初始块结构，创建后可随意修改">
              <div className="grid max-h-56 grid-cols-1 gap-2 overflow-y-auto pr-1 atb-scroll">
                <StartOption
                  selected={template === null}
                  title="空白起步"
                  description="只有一个入口块，从零开始"
                  onClick={() => setTemplateId(null)}
                />
                {SKILL_STARTER_TEMPLATES.map((item) => (
                  <StartOption
                    key={item.id}
                    selected={template?.id === item.id}
                    title={item.name}
                    badge={SKILL_TYPE_META[item.type].label}
                    description={item.description}
                    tags={item.tags}
                    onClick={() => {
                      setTemplateId(item.id);
                      setType(item.type);
                      /* 模板起步：用模板自带分类预填（下方第二步可改）。 */
                      setCategory(item.category);
                    }}
                  />
                ))}
              </div>
            </Field>
          </div>
        ) : (
          <div className="flex flex-col gap-4" data-testid="create-skill-step2">
            <div className="rounded-card border border-border bg-bg-raised px-3 py-2 text-aux text-text-secondary">
              <span className="text-text-primary">{name.trim() || '未命名技能'}</span>
              · {SKILL_TYPE_META[template?.type ?? type].label} ·{' '}
              {template ? `模板「${template.name}」` : '空白起步'}
            </div>
            <Field
              label="描述"
              hint="可选，发布前检查要求描述不为空"
              htmlFor="skill-create-desc"
            >
              <Textarea
                id="skill-create-desc"
                value={template && !description.trim() ? template.description : description}
                rows={3}
                placeholder="这个技能解决什么问题、怎么用"
                onChange={(event) => setDescription(event.target.value)}
              />
            </Field>
            <Field label="标签" hint="可选，逗号或空格分隔">
              <Input
                value={tagsText}
                placeholder={template ? template.tags.join(', ') : 'review, quality'}
                onChange={(event) => setTagsText(event.target.value)}
              />
            </Field>
            <Field
              label="分类"
              hint="单选，11 类 + 未分类（PRD §9.2 系统词表）；模板起步已预填，可改"
            >
              <RadioGroup
                value={category}
                options={SKILL_CATEGORY_OPTIONS}
                onChange={(value) => setCategory(value as SkillCategoryOrNone)}
              />
            </Field>
            <p className="text-aux text-text-tertiary">描述与标签可以留空，之后在编辑器里补充；分类之后也能改。</p>
          </div>
        )}
      </div>
    </Dialog>
  );
}

function StartOption({
  selected,
  title,
  description,
  badge,
  tags,
  onClick,
}: {
  selected: boolean;
  title: string;
  description: string;
  badge?: string;
  tags?: string[];
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        'flex items-start gap-2 rounded-control border px-3 py-2 text-left transition-colors',
        selected
          ? 'border-primary bg-primary-light/40'
          : 'border-border bg-bg-surface hover:border-primary/60 hover:bg-bg-raised',
      )}
    >
      <Sparkles className={cn('mt-0.5 size-4 shrink-0', selected ? 'text-primary' : 'text-text-tertiary')} />
      <span className="min-w-0 flex-1">
        <span className="flex flex-wrap items-center gap-1.5">
          <span className="text-body text-text-primary">{title}</span>
          {badge ? (
            <span className="rounded-badge bg-bg-muted px-1.5 py-0.5 text-badge text-text-secondary">
              {badge}
            </span>
          ) : null}
          {tags?.slice(0, 3).map((tag) => (
            <span key={tag} className="rounded-badge bg-bg-muted px-1.5 py-0.5 text-badge text-text-tertiary">
              {tag}
            </span>
          ))}
        </span>
        <span className="mt-0.5 block text-aux text-text-secondary">{description}</span>
      </span>
    </button>
  );
}
