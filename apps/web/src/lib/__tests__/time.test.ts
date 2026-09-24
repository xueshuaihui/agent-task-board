import { describe, expect, it } from 'vitest';
import { formatDateTime, formatRelative } from '../time';

/**
 * R-A/B2b 缺陷守护：Agent claim 瞬间服务端把 updated_at 推到「此刻」，
 * 略晚于组件手里 30s 一跳的本地时钟快照（useNow），delta 出现几秒级负值。
 * 小幅负 delta（1 分钟内）按「刚刚」处理；明显未来（超过容忍阈值）仍退回绝对时间。
 */

const NOW = Date.parse('2026-09-24T06:00:00Z');

function isoOffsetFromNow(ms: number): string {
  return new Date(NOW + ms).toISOString();
}

describe('formatRelative 小幅负 delta（时钟快照落后于刚写入时间戳）', () => {
  it('delta 为 -5 秒：按「刚刚」处理，不再退回绝对时间', () => {
    const value = isoOffsetFromNow(5_000);
    expect(formatRelative(value, NOW)).toBe('刚刚');
  });

  it('delta 为 -59 秒（容忍阈值内）：仍按「刚刚」处理', () => {
    const value = isoOffsetFromNow(59_000);
    expect(formatRelative(value, NOW)).toBe('刚刚');
  });

  it('delta 为 -2 小时（明显未来）：退回 formatDateTime 绝对时间', () => {
    const value = isoOffsetFromNow(2 * 60 * 60_000);
    expect(formatRelative(value, NOW)).toBe(formatDateTime(value));
  });
});
