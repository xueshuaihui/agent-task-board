import { useEffect, useRef, useState } from 'react';
import { RotateCcw } from 'lucide-react';
import type { BreakdownSession } from '@/api/types';
import { Button, Dialog, Field, Textarea } from '@/components/ui';
import { REGENERATION_NOTE_MAX } from './regeneration';

/**
 * #4 两级「重新生成」的说明输入（轻量 Dialog，形状对齐 SessionActionDialog）：
 * - kind=draft：单条草案，重置该草案等待 Agent 重报；
 * - kind=session：整份，会话回 receiving、所有草案待重报。
 * 说明可空，trim 后 ≤2000 字（与服务端 zod 同口径）。
 */
export interface RegenerationDialogProps {
  open: boolean;
  kind: 'draft' | 'session';
  session: BreakdownSession | null;
  draftRef?: string | null;
  busy: boolean;
  onClose: () => void;
  onSubmit: (note: string) => void;
}

export function RegenerationDialog({
  open,
  kind,
  session,
  draftRef,
  busy,
  onClose,
  onSubmit,
}: RegenerationDialogProps) {
  const [note, setNote] = useState('');
  // 退场动画期间 open=false、目标已清空：保留最后一次的文案，避免标题闪成默认值。
  const lastTarget = useRef<{ kind: 'draft' | 'session'; ref: string | null; title: string }>({
    kind,
    ref: draftRef ?? null,
    title: session?.parent_title ?? '',
  });
  if (open) {
    lastTarget.current = {
      kind,
      ref: draftRef ?? null,
      title: session?.parent_title ?? '',
    };
  }
  const target = open
    ? { kind, ref: draftRef ?? null, title: session?.parent_title ?? '' }
    : lastTarget.current;
  const isDraft = target.kind === 'draft';

  useEffect(() => {
    if (open) setNote('');
  }, [open, kind, draftRef]);

  return (
    <Dialog
      open={open}
      size="form"
      dismissible={!busy}
      onClose={onClose}
      title={isDraft ? `重新生成草案 #${target.ref ?? ''}` : '整份重新生成'}
      footer={
        <>
          <Button variant="ghost" onClick={onClose} disabled={busy}>
            取消
          </Button>
          <Button
            variant="primary"
            loading={busy}
            onClick={() => onSubmit(note)}
            disabled={note.trim().length > REGENERATION_NOTE_MAX}
            data-testid="breakdown-regenerate-submit"
          >
            <RotateCcw className="size-3.5" aria-hidden />
            请求重新生成
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-3">
        <p className="text-body text-text-primary">
          {isDraft ? (
            <>
              将清空草案 <b>#{target.ref}</b> 的生成内容并置为「等待 Agent 重报」。
              确认创建会暂时禁用，直到 Agent 重报或取消会话。
            </>
          ) : (
            <>
              将把会话「{target.title}」交回 Agent 按说明重拆：所有草案挂上「等待 Agent 重报」，
              会话回到接收中；确认创建会暂时禁用，直到 Agent 重报或取消会话。
            </>
          )}
        </p>
        <Field
          label="重生成说明"
          hint={`可选 · 最多 ${REGENERATION_NOTE_MAX} 字`}
          htmlFor="breakdown-regeneration-note"
        >
          <Textarea
            id="breakdown-regeneration-note"
            rows={4}
            value={note}
            maxLength={REGENERATION_NOTE_MAX}
            placeholder="说明希望 Agent 怎么改，例如：拆得更细、补充验收标准、去掉重复任务…"
            onChange={(event) => setNote(event.target.value.slice(0, REGENERATION_NOTE_MAX))}
            data-testid="breakdown-regeneration-note"
          />
        </Field>
        <p className="self-end text-aux tabular-nums text-text-tertiary">
          {note.length}/{REGENERATION_NOTE_MAX}
        </p>
      </div>
    </Dialog>
  );
}
