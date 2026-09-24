import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import * as skillMeta from '../meta';
import { SKILL_CATEGORIES, UNCATEGORIZED_CATEGORY, UNCATEGORIZED_LABEL } from '../meta';

/**
 * C-4 守护测试：web 侧分类词表与 api 单一事实源逐字等值、顺序一致；旧的
 * 「tags 减法凑分类」三件套（categoryTagsOf/audienceTagOf/CATEGORY_TAG_EXCLUDES）不得复活。
 *
 * 词表漂移曾让分类轴随自由标签变化（PRD §19.13 第 82 条的根因），所以这里**不复制一份
 * 清单手工比对**，而是直接读 api 源文件抽数组字面量比对：改一边不改另一边即红。
 */

const here = path.dirname(fileURLToPath(import.meta.url));
/** apps/web 包根：__tests__ → skills → features → src → web。 */
const webRoot = path.resolve(here, '../../../..');
const apiSourceFile = path.join(webRoot, '../api/src/skills/skill-categories.ts');
const metaSourceFile = path.join(here, '../meta.ts');

/** 从 api 源文件抽 `export const SKILL_CATEGORIES = [...] as const` 的数组字面量（按序）。 */
function parseApiSkillCategories(): string[] {
  const source = readFileSync(apiSourceFile, 'utf8');
  const declaration = /export const SKILL_CATEGORIES\s*=\s*\[([\s\S]*?)\]/.exec(source);
  expect(declaration, 'api skill-categories.ts 里应存在 SKILL_CATEGORIES 数组声明').not.toBeNull();
  return [...declaration![1].matchAll(/'([^']*)'/g)].map((match) => match[1]);
}

describe('skill category 词表（web ↔ api 单一事实源）', () => {
  it('web 词表与 api SKILL_CATEGORIES 逐字等值且顺序一致', () => {
    expect([...SKILL_CATEGORIES]).toEqual(parseApiSkillCategories());
  });

  it('词表恰为 12 项、无空串/重复；未分类 = 空串 + 固定文案', () => {
    expect(SKILL_CATEGORIES).toHaveLength(12);
    expect(new Set(SKILL_CATEGORIES).size).toBe(12);
    expect(SKILL_CATEGORIES).not.toContain('');
    expect(UNCATEGORIZED_CATEGORY).toBe('');
    expect(UNCATEGORIZED_LABEL).toBe('未分类');
  });
});

describe('旧的「tags 减法凑分类」helper 下线', () => {
  it('meta.ts 运行时的模块表面不再有 categoryTagsOf/audienceTagOf/CATEGORY_TAG_EXCLUDES', () => {
    const surface = skillMeta as Record<string, unknown>;
    expect(surface.categoryTagsOf).toBeUndefined();
    expect(surface.audienceTagOf).toBeUndefined();
    expect(surface.CATEGORY_TAG_EXCLUDES).toBeUndefined();
  });

  it('meta.ts 源码文本里三个旧导出名整体消失（防换了写法重新导出）', () => {
    const source = readFileSync(metaSourceFile, 'utf8');
    for (const name of ['categoryTagsOf', 'audienceTagOf', 'CATEGORY_TAG_EXCLUDES']) {
      expect(source, `meta.ts 不应再出现 ${name}`).not.toContain(name);
    }
  });
});
