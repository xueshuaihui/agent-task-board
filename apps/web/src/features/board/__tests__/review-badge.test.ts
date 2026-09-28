import { describe, expect, it } from 'vitest';
import type { TaskCard } from '@/api/types';
import { reviewBadgeState } from '../model';

/**
 * 0020 §3.4 的角标判定：待审核列里三种任务共用一列，靠角标分开——
 * 分不开时人会把「等 Agent 审」的一直等着，或以为「已转人工」的还要等 Agent。
 */

const card = (review_mode: TaskCard['review_mode'], review_track: TaskCard['review_track']): Pick<TaskCard, 'review_mode' | 'review_track'> => ({
  review_mode,
  review_track,
});

describe('reviewBadgeState', () => {
  it('auto ∧ track=auto → 等 Agent 领审核（唯一一种不是等自己审的）', () => {
    expect(reviewBadgeState(card('auto', 'auto'))).toMatchObject({ autoWaiting: true, label: '等待自动审核' });
  });

  it('auto 已被人接管 → 不再是自动态，且要说清「不再进自动队列」', () => {
    const state = reviewBadgeState(card('auto', 'human'));
    expect(state.autoWaiting).toBe(false);
    expect(state.tip).toContain('不再进自动审核队列');
  });

  it('human 任务与免审残留态走同一份人审文案（none 正常不落 REVIEW，出现时不静默）', () => {
    expect(reviewBadgeState(card('human', 'human'))).toEqual({
      autoWaiting: false,
      tip: '待你审核',
      label: '待你审核',
    });
    expect(reviewBadgeState(card('none', 'human')).autoWaiting).toBe(false);
  });
});
