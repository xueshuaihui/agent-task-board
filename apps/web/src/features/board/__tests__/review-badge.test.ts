import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { REVIEW_BADGE_LABEL } from '../model';

/**
 * 待审核列卡片角标（2026-10-09 裁定后只剩人审 Bell 一态）：
 * 原三例里的两例（auto∧track=auto 的 Bot 态、auto 已被人接管的换轨态）随
 * 「Agent 当审核方」整链移除——那两种任务形态不再存在，判定函数也删了。
 * 这里钉住剩下的 Bell 态文案与「Bot 角标不得回流」的源码闸。
 */

const WEB_SRC = resolve(import.meta.dirname, '../../..');

describe('待审核列卡片角标', () => {
  it('Bell 态文案仍是「待你审核」', () => {
    expect(REVIEW_BADGE_LABEL).toBe('待你审核');
  });

  it('卡片视图只剩 Bell 一态：不再渲染 Bot 角标，也不再读 review_track', () => {
    const source = readFileSync(resolve(WEB_SRC, 'features/board/task-card-view.tsx'), 'utf8');
    expect(source).toContain('<Bell');
    // 注释里允许提「Bot 态已移除」，但 JSX 与 lucide import 里不许再有 Bot 图标。
    expect(source).not.toMatch(/<Bot[\s/>]/);
    expect(source).not.toMatch(/^\s*Bot,\s*$/m);
    expect(source).not.toContain('review_track');
    expect(source).not.toContain('reviewBadgeState');
  });
});
