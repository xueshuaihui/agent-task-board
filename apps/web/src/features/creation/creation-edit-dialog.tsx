import { useEffect, useMemo, useRef, useState } from 'react';
import { useRequirementOptions } from '@/features/requirements/use-requirement-options';
import { Button, Dialog, Field, Input, Select, Textarea } from '@/components/ui';
import { PRIORITY_LABEL } from '@/lib/labels';
import type { CreationDecisionInput, CreationRequestView } from '@/api/types';

/**
 * §8.3「编辑 → 打开编辑对话框」的最小实现：只给任务内容四字段。
 *
 * 刻意不做全字段表单（自定义字段/标签/技能一概不碰）——卡片是「不打断对话」的轻确认
 * （§8.1），编辑框越厚越不像轻确认；api 侧 `creationDecisionSchema.payload` 也只接受
 * 内容字段，请求身份（agent_name/session_id）改不了（§8.7 r3）。
 *
 * §19.14·84/86（v0.0.4 W2-b）：归属字段改「需求」口径——下拉候选 = 未归档需求、
 * 行值显示该需求标题；**写入仍是该需求的 `group_id`**（零后端约束：
 * `creation.dto.ts` 的 decision payload 字段面只有 group_id、没有父任务字段，
 * 已核实于 apps/api/src/creation/creation.dto.ts——简报所指 contract 目录实际在
 * creation 特性目录）。组内无需求的历史载荷补一条「未分配」回显项，不强行造父挂。
 */
export interface CreationEditDialogProps {
  card: CreationRequestView | null;
  onClose: () => void;
  onSubmit: (payload: NonNullable<CreationDecisionInput['payload']>) => void;
  submitting?: boolean;
}

export function CreationEditDialog({ card, onClose, onSubmit, submitting }: CreationEditDialogProps) {
  // 退场动画接线：消费方关闭时把 card 置 null（`open={card !== null}` 随之翻转）——
  // 这里用 ref 记住「曾打开过」，从未打开则整体不渲染，打开过就保留挂载让 Dialog 播 140ms 退场。
  const everOpenedRef = useRef(card !== null);
  if (card !== null) everOpenedRef.current = true;
  if (!everOpenedRef.current) return null;

  const requirements = useRequirementOptions();
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [priority, setPriority] = useState('2');
  const [groupId, setGroupId] = useState('');

  // 每张卡打开时回填卡片载荷；切到另一张卡（罕见，但栈里可以并存）不会串内容。
  useEffect(() => {
    if (!card) return;
    setTitle(card.title);
    setDescription(card.description ?? '');
    setPriority(String(card.priority));
    setGroupId(card.group_id);
  }, [card]);

  // 下拉候选 = 未归档需求（value 仍写该需求的 group_id：payload 字段面没有父任务
  // 字段，见文件头核实说明）。同组多需求时按组去重取首个（拆解口径一组一需求）；
  // 当前载荷所在组无需求时补一条「未分配」回显项，保证打开即如实展示、未动不脏表单。
  const requirementOptions = useMemo(() => {
    const seen = new Set<string>();
    const options: { value: string; label: string }[] = [];
    for (const option of requirements.data) {
      if (!option.group_id || seen.has(option.group_id)) continue;
      seen.add(option.group_id);
      options.push({ value: option.group_id, label: option.title });
    }
    if (groupId && !seen.has(groupId)) {
      // 组内无（可显示的）需求——回显「未分配」，不发 parent、也不强行造。
      options.unshift({ value: groupId, label: '未分配' });
    }
    return options;
  }, [requirements.data, groupId]);
  const priorityOptions = useMemo(
    () =>
      Object.entries(PRIORITY_LABEL).map(([value, label]) => ({
        value,
        // PRIORITY_LABEL 的值已含「P0/P1…」字样时不重复加前缀。
        label: label.startsWith(`P${value}`) ? label : `P${value} ${label}`,
      })),
    [],
  );

  const trimmed = title.trim();
  const dirty =
    card !== null &&
    (trimmed !== card.title ||
      description !== (card.description ?? '') ||
      Number(priority) !== card.priority ||
      groupId !== card.group_id);

  return (
    <Dialog
      open={card !== null}
      onClose={onClose}
      title="编辑后创建"
      footer={
        <>
          <Button variant="ghost" onClick={onClose} disabled={submitting}>
            返回
          </Button>
          <Button
            variant="primary"
            disabled={trimmed.length === 0 || !dirty || submitting}
            onClick={() =>
              onSubmit({
                title: trimmed,
                description: description.trim() === '' ? null : description,
                priority: Number(priority),
                group_id: groupId,
              })
            }
          >
            {submitting ? '提交中…' : '创建'}
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-3">
        <Field label="标题" required htmlFor="creation-edit-title">
          <Input
            id="creation-edit-title"
            value={title}
            onChange={(event) => setTitle(event.target.value)}
            data-testid="creation-edit-title"
          />
        </Field>
        <Field label="描述" htmlFor="creation-edit-desc">
          <Textarea
            id="creation-edit-desc"
            rows={4}
            value={description}
            onChange={(event) => setDescription(event.target.value)}
          />
        </Field>
        <div className="grid grid-cols-2 gap-3">
          <Field label="优先级" htmlFor="creation-edit-priority">
            <Select
              id="creation-edit-priority"
              value={priority}
              options={priorityOptions}
              onChange={(event) => setPriority(event.target.value)}
            />
          </Field>
          <Field label="需求" htmlFor="creation-edit-requirement">
            <Select
              id="creation-edit-requirement"
              value={groupId}
              options={requirementOptions}
              placeholder="加载中…"
              onChange={(event) => setGroupId(event.target.value)}
            />
          </Field>
        </div>
        <p className="text-aux text-text-tertiary">
          类型、标签与技能沿用 Agent 原载荷；本次修改随 decision 一并回传（§8.7 r3）。
        </p>
      </div>
    </Dialog>
  );
}
