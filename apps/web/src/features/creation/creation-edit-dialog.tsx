import { useEffect, useMemo, useRef, useState } from 'react';
import { Button, Dialog, Field, Input, Select, Textarea } from '@/components/ui';
import { PRIORITY_LABEL, REVIEW_MODE_LABEL } from '@/lib/labels';
import { ReviewModeField } from '@/features/review/review-mode-field';
import type { CreationDecisionInput, CreationRequestView, ReviewMode } from '@/api/types';

/**
 * §8.3「编辑 → 打开编辑对话框」的最小实现：任务内容字段 + 审核方式。
 *
 * 刻意不做全字段表单（自定义字段/标签/技能一概不碰）——卡片是「不打断对话」的轻确认
 * （§8.1），编辑框越厚越不像轻确认；api 侧 `creationDecisionSchema.payload` 只接受
 * 内容字段与归属/审核方式，请求身份（agent_name/session_id）改不了（§8.7 r3）。
 *
 * 归属不在本弹窗编辑（§19.15·90/91 删除假归属口后的口径）：服务端 decision payload
 * 现在虽已接受 `parent_task_id`（#5），本片仍只做审核方式；归属只在卡片行只读展示，
 * 编辑入口在任务详情页「所属需求」。不要借这次改动扩大成归属编辑。
 *
 * 审核方式（#5 Q4）：默认选中卡片上的拟用值（`review_mode`），Agent 的
 * `requested_review_mode` 只作辅助说明；用户在这里的最终选择随 edit payload 回传，
 * 是唯一能落 `review_mode` 的地方。
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

  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [priority, setPriority] = useState('2');
  // 编辑态不给「跟随全局默认」：卡片上已是服务端拟用值，默认选中它就是用户所见即所得。
  const [reviewMode, setReviewMode] = useState<ReviewMode>(card?.review_mode ?? 'human');

  // 每张卡打开时回填卡片载荷；切到另一张卡（罕见，但栈里可以并存）不会串内容。
  useEffect(() => {
    if (!card) return;
    setTitle(card.title);
    setDescription(card.description ?? '');
    setPriority(String(card.priority));
    setReviewMode(card.review_mode);
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

  // 早退必须在所有 hooks 之后：card null→非空切换时若少调 hooks，React 会抛
  // 「Rendered more hooks than during the previous render」。
  if (!everOpenedRef.current) return null;

  const trimmed = title.trim();
  const reviewModeDirty = card !== null && reviewMode !== card.review_mode;
  const dirty =
    card !== null &&
    (trimmed !== card.title ||
      description !== (card.description ?? '') ||
      Number(priority) !== card.priority ||
      reviewModeDirty);
  const requestedReviewMode = card?.requested_review_mode ?? null;

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
                // 与卡片拟用值一致时不发（保持 payload 最小、dirty 语义一致）。
                ...(reviewModeDirty ? { review_mode: reviewMode } : {}),
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
        <ReviewModeField
          value={reviewMode}
          onChange={(next) => {
            if (next !== '') setReviewMode(next);
          }}
          allowDefault={false}
        />
        {requestedReviewMode ? (
          <p className="text-aux text-text-tertiary" data-testid="creation-edit-review-mode-request">
            Agent 请求的审核方式：{REVIEW_MODE_LABEL[requestedReviewMode]}；最终以这里的选择为准。
          </p>
        ) : null}
        <p className="text-aux text-text-tertiary">
          类型、标签与技能沿用 Agent 原载荷；审核方式与本次修改随 decision 一并回传（§8.7 r3）。
          需求归属只在卡片行展示，编辑请到任务详情页「所属需求」设置（§19.15·91）。
        </p>
      </div>
    </Dialog>
  );
}
