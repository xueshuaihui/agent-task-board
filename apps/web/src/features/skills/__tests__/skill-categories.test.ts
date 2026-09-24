import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import * as skillMeta from '../meta';
import { SKILL_CATEGORIES, SKILL_STARTER_TEMPLATES, UNCATEGORIZED_CATEGORY, UNCATEGORIZED_LABEL } from '../meta';
import { toSkillCategory } from '../markdown';

/**
 * C-4 守护测试：web 侧分类词表与 api 单一事实源逐字等值、顺序一致；旧的
 * 「tags 减法凑分类」三件套（categoryTagsOf/audienceTagOf/CATEGORY_TAG_EXCLUDES）不得复活。
 *
 * 词表漂移曾让分类轴随自由标签变化（PRD §19.13 第 82 条的根因），所以这里**不复制一份
 * 清单手工比对**，而是直接读 api 源文件抽数组字面量比对：改一边不改另一边即红。
 *
 * C-5 追加：8 个起步模板必须自带词表内分类（模板是给用户当范用的，'' 等于示范错误
 * 用法）；frontmatter category 归一函数 toSkillCategory 与 api 导入口径一致
 * （词表外一律落 ''，不报错）。
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

describe('起步模板自带分类（C-5 写侧收口）', () => {
  it('8 个模板齐全', () => {
    expect(SKILL_STARTER_TEMPLATES).toHaveLength(8);
  });

  it('每个模板的 category 都在 12 词表内且不是未分类 \'\'（模板当范用，不许示范错误用法）', () => {
    for (const template of SKILL_STARTER_TEMPLATES) {
      expect(
        SKILL_CATEGORIES,
        `模板 ${template.id} 的 category「${template.category}」不在词表内`,
      ).toContain(template.category);
      expect(template.category, `模板 ${template.id} 不许用未分类 '' 蒙混`).not.toBe('');
    }
  });
});

describe('frontmatter category 归一 toSkillCategory（与 api 导入口径一致）', () => {
  it('词表内值原样采纳（12 词逐一）', () => {
    for (const value of SKILL_CATEGORIES) {
      expect(toSkillCategory(value)).toBe(value);
    }
  });

  it('词表外值（含旧包把 category 写成类型枚举值）与空串一律落未分类 \'\'、不报错', () => {
    for (const raw of ['', 'workflow', 'flow', 'prompt', '官方', ' 质量保障', '质量保障 ']) {
      expect(toSkillCategory(raw), `raw=${JSON.stringify(raw)}`).toBe('');
    }
  });
});
