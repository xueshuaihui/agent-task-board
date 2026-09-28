import { useEffect, useMemo, useRef, useState } from 'react';
import { Button, Dialog, Field, Input, Select, Textarea } from '@/components/ui';
import { PRIORITY_LABEL } from '@/lib/labels';
import type { CreationDecisionInput, CreationRequestView } from '@/api/types';

/**
 * §8.3「编辑 → 打开编辑对话框」的最小实现：只给任务内容字段。
 *
 * 刻意不做全字段表单（自定义字段/标签/技能一概不碰）——卡片是「不打断对话」的轻确认
 * （§8.1），编辑框越厚越不像轻确认；api 侧 `creationDecisionSchema.payload` 也只接受
 * 内容字段，请求身份（agent_name/session_id）改不了（§8.7 r3）。
 *
 * §19.15·90/91 追加段（v0.0.4 r6 R3-C）：归属下拉**整块退场**。§19.14 时代的下拉
 * 显示需求标题、写入的却是该需求的**所属分组 id**（`creation.dto.ts` 的 decision
 * payload 字段面没有 `parent_task_id`），是「显示需求、写分组」的假归属口，r6 拍板
 * 删除：编辑后创建只提交标题 / 描述 / 优先级三字段，未带归属的新任务由服务端按
 * §5.2 落「默认」分组兜底；**需求归属请去任务详情页「所属需求」设置**（该腿已在
 * §19.15·91 收口为只写 `parent_task_id`）。给 creation 载荷补 `parent_task_id`
 * 属服务端改造，另起后续批（§19.15·92），不在本片混提。
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

  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [priority, setPriority] = useState('2');

  // 每张卡打开时回填卡片载荷；切到另一张卡（罕见，但栈里可以并存）不会串内容。
  useEffect(() => {
    if (!card) return;
    setTitle(card.title);
    setDescription(card.description ?? '');
    setPriority(String(card.priority));
  }, [card]);

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
    (trimmed !== card.title || description !== (card.description ?? '') || Number(priority) !== card.priority);

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
        <Field label="优先级" htmlFor="creation-edit-priority">
          <Select
            id="creation-edit-priority"
            value={priority}
            options={priorityOptions}
            onChange={(event) => setPriority(event.target.value)}
          />
        </Field>
        <p className="text-aux text-text-tertiary">
          类型、标签与技能沿用 Agent 原载荷；本次修改随 decision 一并回传（§8.7 r3）。
          需求归属请到任务详情页「所属需求」设置（§19.15·91）。
        </p>
      </div>
    </Dialog>
  );
}
