import { describe, expect, it } from 'vitest';
import type { BreakdownDraft } from '@/api/types';
import { REGEN_PLACEHOLDER_TITLE, applyRegeneration, normalizeAcceptance } from '../draft-edit';

/**
 * v0.0.4 §7.4 补齐（条款 81）：验收标准归一 + 「重新生成」乐观覆盖的纯函数用例。
 * 与 api 侧同口径的判据都在这里锁住：normalizeAcceptance ≡ 服务端
 * `toStringArray → trim → filter(Boolean)`；applyRegeneration ≡ userRegenerateDraft
 * 的字段清空集（title 占位、description/skill_ids/acceptance/depends_on 清空、
 * priority/sort_order 保留）。node 环境跑，不依赖 React（参照 creation 片测试风格）。
 */

function draft(over: Partial<BreakdownDraft> & { ref: string }): BreakdownDraft {
  return {
    id: `id-${over.ref}`,
    title: `任务 ${over.ref}`,
    description: null,
    priority: 2,
    skill_ids: ['sk-1'],
    acceptance: ['条目一', '条目二'],
    depends_on: ['t1'],
    sort_order: 1,
    ...over,
  };
}

describe('normalizeAcceptance：与服务端 trim+filter 同口径', () => {
  it('逐条 trim、丢空白项（含纯空格）', () => {
    expect(normalizeAcceptance(['  带空格  ', '', '   ', '实值'])).toEqual(['带空格', '实值']);
  });

  it('已归一的列表原样保留（幂等，blur 重复提交不会抖动出 diff）', () => {
    const once = normalizeAcceptance(['a', 'b']);
    expect(normalizeAcceptance(once)).toEqual(once);
  });

  it('空数组/全空白归一为空表——PATCH 后卡片「验收 N 项」徽标消失', () => {
    expect(normalizeAcceptance([])).toEqual([]);
    expect(normalizeAcceptance([' ', '\t'])).toEqual([]);
  });
});

describe('applyRegeneration：重新生成的乐观覆盖', () => {
  const drafts = [draft({ ref: 't1' }), draft({ ref: 't2', depends_on: ['t1'] })];

  it('目标草案：占位标题 + 生成字段清空 + regeneration_pending；priority/sort_order 保留', () => {
    const [t1, t2] = applyRegeneration(drafts, 't1');
    expect(t1).toMatchObject({
      ref: 't1',
      title: REGEN_PLACEHOLDER_TITLE,
      description: null,
      skill_ids: [],
      acceptance: [],
      depends_on: [],
      regeneration_pending: true,
    });
    expect(t1?.priority).toBe(2);
    expect(t1?.sort_order).toBe(1);
    expect(t1?.id).toBe('id-t1');
    // t2 的依赖边按 ref 坐标仍指 t1（重置不删行，服务端也如此）——本函数只动目标。
    expect(t2).toEqual(drafts[1]);
  });

  it('不可变：入参数组原样不动', () => {
    const snapshot = JSON.stringify(drafts);
    applyRegeneration(drafts, 't1');
    expect(JSON.stringify(drafts)).toBe(snapshot);
  });

  it('未知 ref：全集原样返回（服务端此时已 404，乐观层不虚晃）', () => {
    expect(applyRegeneration(drafts, 'n9')).toEqual(drafts);
  });
});
