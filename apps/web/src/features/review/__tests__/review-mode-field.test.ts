import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { REVIEW_MODE_CHOICES, reviewModeBody } from '../review-mode-field';

/**
 * 0020 §3.1/§3.5 的两条闸：
 * 1) `''`（跟随全局默认）必须**不发字段**——发 `review_mode: ''` 会 422，发 human 会把
 *    设置页的 `default_review_mode` 架空（2026-09-28 拍板「三条建单路一处口径」）；
 * 2) 三个入口共用同一份选择器，靠源码闸钉住——漏一处就是那条路自己造了一套口径。
 */

const WEB_SRC = resolve(import.meta.dirname, '../../..');

describe('reviewModeBody（建单请求体的审核方式腿）', () => {
  it('三枚实值各自原样落键，取值域不超出后端 REVIEW_MODES', () => {
    expect(REVIEW_MODE_CHOICES).toEqual(['human', 'auto', 'none']);
    for (const mode of REVIEW_MODE_CHOICES) {
      expect(reviewModeBody(mode)).toEqual({ review_mode: mode });
    }
  });

  it('「跟随全局默认」= 整个键都不发，交服务端 resolveReviewMode 回落', () => {
    expect(reviewModeBody('')).toEqual({});
    expect(JSON.stringify(reviewModeBody(''))).toBe('{}');
  });
});

describe('建单/编辑三处挂的是同一个 ReviewModeField', () => {
  const files = [
    'features/task-detail/create-task-dialog.tsx',
    'features/board/quick-create.tsx',
    'features/task-detail/tabs/overview.tsx',
  ];

  for (const file of files) {
    it(`${file} import 共享选择器而不是自带一套下拉`, () => {
      const source = readFileSync(resolve(WEB_SRC, file), 'utf8');
      expect(source).toContain('@/features/review/review-mode-field');
      expect(source).toMatch(/<ReviewModeField/);
    });
  }

  /**
   * 需求不执行、永远不进 REVIEW（1.md 5.2），给它选审核方式是死字段。
   * 两个建单入口的「钉死/选中需求」分支必须在 `<ReviewModeField` 之前把这一项挡掉。
   */
  it.each([
    ['features/task-detail/create-task-dialog.tsx', /asRequirement \? null :/],
    ['features/board/quick-create.tsx', /type === '需求' \? null :/],
  ])('%s 在需求分支里不给审核方式', (file, gate) => {
    const source = readFileSync(resolve(WEB_SRC, file), 'utf8');
    const at = source.search(gate);
    expect(at).toBeGreaterThan(-1);
    expect(source.indexOf('<ReviewModeField', at)).toBeGreaterThan(at);
  });
});
