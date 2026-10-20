import type { BreakdownDraft, BreakdownSessionStatus } from '@/api/types';

/**
 * #4 重生成闭环的纯判据与文案（web 无 jsdom，组件行为之外的部分都放这里直测）。
 */

/** 与后端 `breakdownRegenerateBodySchema` 的 note 上限一致（trim 后 ≤2000 字）。 */
export const REGENERATION_NOTE_MAX = 2000;

/** 是否存在「等待 Agent 重报」的草案——确认创建必须被禁用（服务端也会 409）。 */
export function hasPendingRegeneration(
  drafts: readonly Pick<BreakdownDraft, 'regeneration_pending'>[],
): boolean {
  return drafts.some((draft) => draft.regeneration_pending === true);
}

/**
 * 确认创建的纯判据：只有 reviewing 且没有待重报草案时才允许。
 * 组件侧据此 `disabled`，并在按钮就近给出原因；服务端 409 只是第二道闸。
 */
export function confirmBlockedReason(
  status: BreakdownSessionStatus,
  drafts: readonly Pick<BreakdownDraft, 'regeneration_pending'>[],
): string | null {
  if (status !== 'reviewing') return '当前状态不能确认创建';
  if (hasPendingRegeneration(drafts)) {
    return '有草案正在等待 Agent 重报，确认创建已禁用';
  }
  return null;
}

export function canConfirmBreakdown(
  status: BreakdownSessionStatus,
  drafts: readonly Pick<BreakdownDraft, 'regeneration_pending'>[],
): boolean {
  return confirmBlockedReason(status, drafts) === null;
}

export interface CopyInstructionInput {
  sessionId: string;
  /** 当前会话 revision（GET 详情里的 session.revision）。 */
  revision?: number | null;
  /** 用户填的重生成说明（整份取会话级，单条取草案级）。 */
  note?: string | null;
  /** 单条重生成时给 ref 列表；空/缺省 = 整份。 */
  refs?: readonly string[];
}

/**
 * 复制给 Agent 的「唤起指令」（#4 拍板文案）：
 * 会话 id、说明（若有）、建议先 wait_for_breakdown（带 after_revision）或 get_breakdown。
 * 纯函数，便于钉住「有/无 note、带 revision」三种形态。
 */
export function breakdownCopyInstruction({
  sessionId,
  revision,
  note,
  refs,
}: CopyInstructionInput): string {
  const noteText = note?.trim() ? `（说明：${note.trim()}）` : '';
  const targetText =
    refs && refs.length > 0 ? `草案 ${refs.map((ref) => `#${ref}`).join('、')}` : '';
  const revisionText =
    typeof revision === 'number' && Number.isFinite(revision)
      ? `（after_revision=${revision}）`
      : '';
  return `拆解会话 ${sessionId} 已请求重新生成${targetText}${noteText}。请调用 board.wait_for_breakdown 等待指示${revisionText}，或先 board.get_breakdown(session_id) 读取最新草案。`;
}
