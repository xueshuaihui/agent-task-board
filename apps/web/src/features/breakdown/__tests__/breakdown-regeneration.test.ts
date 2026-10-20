import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { breakdownListPath } from '@/api/resources/breakdown';
import {
  breakdownCopyInstruction,
  canConfirmBreakdown,
  confirmBlockedReason,
  hasPendingRegeneration,
  REGENERATION_NOTE_MAX,
} from '../regeneration';

/**
 * #4 重生成闭环的前端纯逻辑与接线闸（web 无 jsdom，口径同
 * `requirements/__tests__/requirement-rules-ui.test.ts`）：
 * - 列表查询串只发有值的键（scope / requirement / include_archived / limit / cursor）；
 * - 「复制唤起指令」在 有/无说明、带/不带 revision、单条/整份 六种形态下的文案；
 * - 待重报时确认创建的纯判据（按钮 disabled 与服务端 409 同一条口径）；
 * - 源码扫描：说明输入 ≤2000、草案卡 pending 文案、overlay 的复制/禁用接线。
 */

const WEB_SRC = resolve(import.meta.dirname, '../../..');
const read = (path: string) => readFileSync(resolve(WEB_SRC, path), 'utf8');

describe('breakdownListPath：只序列化有值的键', () => {
  it('无参数不带问号', () => {
    expect(breakdownListPath()).toBe('/breakdown/sessions');
    expect(breakdownListPath({})).toBe('/breakdown/sessions');
  });

  it('scope 与 requirement 按值拼入；requirement 先 trim，空白即省略', () => {
    expect(breakdownListPath({ scope: 'history' })).toBe('/breakdown/sessions?scope=history');
    expect(breakdownListPath({ requirement_id: '  req-1  ' })).toBe(
      '/breakdown/sessions?requirement_id=req-1',
    );
    expect(breakdownListPath({ requirement_id: '   ' })).toBe('/breakdown/sessions');
    expect(breakdownListPath({ requirement_id: '' })).toBe('/breakdown/sessions');
  });

  it('include_archived=false 是显式值照样发送；undefined 才省略', () => {
    expect(breakdownListPath({ scope: 'active', include_archived: false })).toBe(
      '/breakdown/sessions?scope=active&include_archived=false',
    );
    expect(breakdownListPath({ include_archived: true })).toBe(
      '/breakdown/sessions?include_archived=true',
    );
    expect(breakdownListPath({ include_archived: undefined })).toBe('/breakdown/sessions');
  });

  it('limit / cursor 只在有值时出现，完整参数按 scope→archived→requirement→limit→cursor 排列', () => {
    expect(breakdownListPath({ limit: 20 })).toBe('/breakdown/sessions?limit=20');
    expect(breakdownListPath({ cursor: 's-9' })).toBe('/breakdown/sessions?cursor=s-9');
    expect(
      breakdownListPath({
        scope: 'all',
        include_archived: true,
        requirement_id: 'req 1',
        limit: 50,
        cursor: 's-1',
      }),
    ).toBe(
      '/breakdown/sessions?scope=all&include_archived=true&requirement_id=req+1&limit=50&cursor=s-1',
    );
  });

  it('undefined / 空白字段全部不出现（不会发出 `cursor=` 这类空键）', () => {
    const path = breakdownListPath({
      scope: 'history',
      include_archived: undefined,
      requirement_id: undefined,
      limit: undefined,
      cursor: undefined,
    });
    expect(path).toBe('/breakdown/sessions?scope=history');
    expect(path).not.toMatch(/cursor=|limit=|requirement_id=|include_archived=/);
  });
});

describe('breakdownCopyInstruction：有/无说明、带/不带 revision、单条/整份', () => {
  it('无说明、无 revision、整份：基础文案仍给 wait 与 get 两条建议', () => {
    expect(breakdownCopyInstruction({ sessionId: 's-1' })).toBe(
      '拆解会话 s-1 已请求重新生成。请调用 board.wait_for_breakdown 等待指示，或先 board.get_breakdown(session_id) 读取最新草案。',
    );
  });

  it('带说明与 revision：说明进括号、after_revision 跟在 wait_for_breakdown 后', () => {
    expect(
      breakdownCopyInstruction({
        sessionId: 's-1',
        revision: 3,
        note: '把登录拆得更细',
      }),
    ).toBe(
      '拆解会话 s-1 已请求重新生成（说明：把登录拆得更细）。请调用 board.wait_for_breakdown 等待指示（after_revision=3），或先 board.get_breakdown(session_id) 读取最新草案。',
    );
  });

  it('单条重生成带 refs：目标写成「草案 #t1、#t2」，说明照旧', () => {
    expect(
      breakdownCopyInstruction({
        sessionId: 's-2',
        revision: 0,
        note: '补充验收标准',
        refs: ['t1', 't2'],
      }),
    ).toBe(
      '拆解会话 s-2 已请求重新生成草案 #t1、#t2（说明：补充验收标准）。请调用 board.wait_for_breakdown 等待指示（after_revision=0），或先 board.get_breakdown(session_id) 读取最新草案。',
    );
  });

  it('说明只有空白 / revision 非数字时不生成空括号', () => {
    const text = breakdownCopyInstruction({
      sessionId: 's-3',
      revision: Number.NaN,
      note: '   ',
    });
    expect(text).toBe(
      '拆解会话 s-3 已请求重新生成。请调用 board.wait_for_breakdown 等待指示，或先 board.get_breakdown(session_id) 读取最新草案。',
    );
    expect(text).not.toContain('（说明：');
    expect(text).not.toContain('after_revision');
  });
});

describe('待重报 → 确认创建禁用的纯判据', () => {
  const pending = [{ regeneration_pending: true }];
  const clean = [{ regeneration_pending: false }, {}];

  it('hasPendingRegeneration 只认显式 true', () => {
    expect(hasPendingRegeneration([])).toBe(false);
    expect(hasPendingRegeneration(clean)).toBe(false);
    expect(hasPendingRegeneration(pending)).toBe(true);
  });

  it('reviewing 且无待重报才允许确认；有 pending 时给按钮就近原因', () => {
    expect(confirmBlockedReason('reviewing', [])).toBeNull();
    expect(canConfirmBreakdown('reviewing', [])).toBe(true);
    expect(confirmBlockedReason('reviewing', pending)).toBe(
      '有草案正在等待 Agent 重报，确认创建已禁用',
    );
    expect(canConfirmBreakdown('reviewing', pending)).toBe(false);
  });

  it('receiving / completed 等非 reviewing 状态一律禁用（与旧按钮口径一致）', () => {
    for (const status of ['receiving', 'creating', 'completed', 'cancelled', 'interrupted'] as const) {
      expect(confirmBlockedReason(status, [])).toBe('当前状态不能确认创建');
      expect(canConfirmBreakdown(status, [])).toBe(false);
    }
  });

  it('说明上限与服务端 zod 同口径（2000）', () => {
    expect(REGENERATION_NOTE_MAX).toBe(2000);
  });
});

describe('组件与源码接线（说明输入 / pending 展示 / 复制唤起指令）', () => {
  const overlay = read('features/breakdown/breakdown-overlay.tsx');
  const dialog = read('features/breakdown/regeneration-dialog.tsx');
  const draftCard = read('features/breakdown/draft-card.tsx');
  const copyText = read('features/breakdown/copy-text.ts');

  it('单条重新生成先收集说明再调 API，不再直接 mutate', () => {
    expect(overlay).toContain("setRegenTarget({ kind: 'draft', ref })");
    expect(overlay).toContain('regenerateDraft.mutateAsync({ id: session.id, ref: regenTarget.ref, note })');
    expect(overlay).toContain('regenerateSession.mutateAsync({ id: session.id, note })');
  });

  it('说明输入 ≤2000 字，标题区分单条/整份，提交按钮有 testid', () => {
    expect(dialog).toContain('maxLength={REGENERATION_NOTE_MAX}');
    expect(dialog).toContain('note.trim().length > REGENERATION_NOTE_MAX');
    expect(dialog).toContain('重新生成草案 #');
    expect(dialog).toContain('整份重新生成');
    expect(dialog).toContain('data-testid="breakdown-regenerate-submit"');
  });

  it('pending 草案显示「等待 Agent 重报」+ 说明 + 请求时间', () => {
    expect(draftCard).toContain('等待 Agent 重报');
    expect(draftCard).toContain('draft.regeneration_note');
    expect(draftCard).toContain('draft.regeneration_requested_at');
    expect(draftCard).toContain('data-testid="breakdown-draft-regeneration-pending"');
  });

  it('确认按钮由 canConfirmBreakdown 驱动 disabled，并有就近原因（不是等 409）', () => {
    expect(overlay).toContain('const canConfirm = canConfirmBreakdown(session.status, drafts)');
    expect(overlay).toContain('disabled={!canConfirm}');
    expect(overlay).toContain('data-testid="breakdown-confirm-blocked"');
    expect(overlay).toContain('{blockedReason');
  });

  it('复制唤起指令用共享纯函数 + 剪贴板兜底，并弹 toast', () => {
    expect(overlay).toContain('breakdownCopyInstruction({');
    expect(overlay).toContain('copyTextWithFallback(text)');
    expect(overlay).toContain('toast.success(\'唤起指令已复制\'');
    expect(overlay).toContain('data-testid="breakdown-copy-instruction"');
    expect(overlay).toContain('data-testid="breakdown-copy-draft-instruction"');
    expect(copyText).toContain('navigator.clipboard.writeText(text)');
    expect(copyText).toContain("document.execCommand('copy')");
  });

  it('整份重生成按钮只在 reviewing 出现', () => {
    expect(overlay).toContain('data-testid="breakdown-regenerate-session"');
    expect(overlay).toContain('session.status === \'reviewing\'');
  });
});
