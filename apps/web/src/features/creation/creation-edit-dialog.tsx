import { useEffect, useMemo, useState } from 'react';
import { useActiveGroups } from '@/features/groups';
import { Button, Dialog, Field, Input, Select, Textarea } from '@/components/ui';
import { PRIORITY_LABEL } from '@/lib/labels';
import type { CreationDecisionInput, CreationRequestView } from '@/api/types';

/**
 * §8.3「编辑 → 打开编辑对话框」的最小实现：只给任务内容四字段。
 *
 * 刻意不做全字段表单（自定义字段/标签/技能一概不碰）——卡片是「不打断对话」的轻确认
 * （§8.1），编辑框越厚越不像轻确认；api 侧 `creationDecisionSchema.payload` 也只接受
 * 内容字段，请求身份（agent_name/session_id）改不了（§8.7 r3）。
 */
export interface CreationEditDialogProps {
  card: CreationRequestView | null;
  onClose: () => void;
  onSubmit: (payload: NonNullable<CreationDecisionInput['payload']>) => void;
  submitting?: boolean;
}

export function CreationEditDialog({ card, onClose, onSubmit, submitting }: CreationEditDialogProps) {
  const groups = useActiveGroups();
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

  const groupOptions = useMemo(
    () => (groups.data?.items ?? []).map((group) => ({ value: group.id, label: group.name })),
    [groups.data],
  );
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
          <Field label="分组" htmlFor="creation-edit-group">
            <Select
              id="creation-edit-group"
              value={groupId}
              options={groupOptions}
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
