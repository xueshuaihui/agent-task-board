import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { creationReviewModeNotice } from '../review-mode-notice';

/**
 * #5 Q4 前端闸：Agent 只能「请求」审核方式，最终值由用户在轻确认卡决定。
 *
 * web 测试没有 jsdom（同本目录既有口径），「请求 vs 实际」的文案判定由纯函数
 * `creationReviewModeNotice` 直钉；组件侧只做源码扫描，确认卡片与编辑弹窗确实接线。
 */

const FEATURE_DIR = join(__dirname, '..');

describe('creationReviewModeNotice：请求值 vs 实际值', () => {
  it('请求 none、实际 human → 显眼警告「Agent 请求免审核，请确认」', () => {
    expect(creationReviewModeNotice('none', 'human')).toEqual({
      kind: 'alert',
      text: 'Agent 请求免审核，请确认',
    });
  });

  it('请求 none、实际 none → 仍然显眼警告，免审核必须由用户亲自确认', () => {
    expect(creationReviewModeNotice('none', 'none')).toEqual({
      kind: 'alert',
      text: 'Agent 请求免审核，请确认',
    });
  });

  it('请求 human、实际 none → 显眼警告「Agent 请求人工审核，请确认」', () => {
    expect(creationReviewModeNotice('human', 'none')).toEqual({
      kind: 'alert',
      text: 'Agent 请求人工审核，请确认',
    });
  });

  it('请求 human、实际 human → 安静标注「审核：人工审核 · Agent 请求」', () => {
    expect(creationReviewModeNotice('human', 'human')).toEqual({
      kind: 'quiet',
      text: '审核：人工审核 · Agent 请求',
    });
  });

  it('没有请求（null / undefined）→ 不显示任何请求提示', () => {
    expect(creationReviewModeNotice(null, 'human')).toBeNull();
    expect(creationReviewModeNotice(null, 'none')).toBeNull();
    expect(creationReviewModeNotice(undefined, 'human')).toBeNull();
  });
});

describe('卡片与编辑弹窗接线（源码扫描，无 jsdom）', () => {
  const card = readFileSync(join(FEATURE_DIR, 'creation-card.tsx'), 'utf8');
  const dialog = readFileSync(join(FEATURE_DIR, 'creation-edit-dialog.tsx'), 'utf8');

  it('卡片始终展示实际审核方式，请求不一致时用 status-review 色系显眼提示', () => {
    expect(card).toContain("from './review-mode-notice'");
    expect(card).toContain('creationReviewModeNotice(card.requested_review_mode, card.review_mode)');
    expect(card).toContain('REVIEW_MODE_LABEL[card.review_mode]');
    expect(card).toContain('data-testid="creation-review-mode-request"');
    expect(card).toContain("reviewNotice?.kind === 'alert' && pending");
    expect(card).toMatch(/border-status-review\/40 bg-status-review-soft/);
  });

  it('卡片归属优先按 parent_task_id 精确反查；旧请求保留 group 反查，查不到不冒充「未分配」', () => {
    expect(card).toContain('card.parent_task_id');
    expect(card).toContain('requirements.data.find((option) => option.id === card.parent_task_id)');
    expect(card).toContain('requirementTitleForGroup(requirements.data, card.group_id)');
    expect(card).toContain('未知需求');
    expect(card).toContain('data-testid="creation-card"');
  });

  it('弹窗复用 ReviewModeField、默认选中 card.review_mode，并辅助展示 Agent 请求', () => {
    expect(dialog).toContain("@/features/review/review-mode-field");
    expect(dialog).toMatch(/<ReviewModeField/);
    expect(dialog).toContain('allowDefault={false}');
    expect(dialog).toContain('setReviewMode(card.review_mode)');
    expect(dialog).toContain('card?.requested_review_mode');
    expect(dialog).toContain('Agent 请求的审核方式');
  });

  it('弹窗 dirty 与提交体纳入 review_mode（仅与拟用值不同时携带）', () => {
    expect(dialog).toContain('reviewMode !== card.review_mode');
    expect(dialog).toMatch(/\.\.\.\(reviewModeDirty \? \{ review_mode: reviewMode \} : \{\}\)/);
  });

  it('弹窗早退位于全部 hooks 之后（card null→非空不得触发 hooks 数量变化）', () => {
    const earlyReturn = dialog.indexOf('if (!everOpenedRef.current) return null;');
    expect(earlyReturn).toBeGreaterThan(dialog.indexOf('const priorityOptions = useMemo('));
    expect(earlyReturn).toBeGreaterThan(dialog.indexOf('useEffect('));
  });
});
