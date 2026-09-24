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
 *
 * 0925 拍板四追加：词表 12 → 11（删「开学季」），并新增第三层比对——api 数组字面量
 * 必须与 0017 迁移重建 skills 表时的列级 CHECK IN 列表逐项一致（0017 是 CHECK 的
 * 现行真值源，0015 只作历史回填口径）。
 */

const here = path.dirname(fileURLToPath(import.meta.url));
/** apps/web 包根：__tests__ → skills → features → src → web。 */
const webRoot = path.resolve(here, '../../../..');
const apiSourceFile = path.join(webRoot, '../api/src/skills/skill-categories.ts');
const metaSourceFile = path.join(here, '../meta.ts');
/** 0017 迁移：skills 表整表重建后的列定义里挂着 category CHECK 的现行真值源。 */
const migration0017File = path.join(
  webRoot,
  '../api/prisma/migrations/0017_skill_category_11_terms/migration.sql',
);

/** 抽 0017 迁移里 category CHECK 的 IN 列表（去掉 ''=未分类，只留词表词，按序）。 */
function parseMigration0017CheckCategories(): string[] {
  const source = readFileSync(migration0017File, 'utf8');
  const declaration =
    /category\s+TEXT NOT NULL DEFAULT ''\s+CHECK \(category IN \(([^)]*)\)\)/.exec(source);
  expect(declaration, '0017 迁移里应存在带 CHECK 的 category 列定义').not.toBeNull();
  return [...declaration![1].matchAll(/'([^']*)'/g)]
    .map((match) => match[1])
    .filter((value) => value !== '');
}

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

  it('词表恰为 11 项、无空串/重复；未分类 = 空串 + 固定文案', () => {
    expect(SKILL_CATEGORIES).toHaveLength(11);
    expect(new Set(SKILL_CATEGORIES).size).toBe(11);
    expect(SKILL_CATEGORIES).not.toContain('');
    expect(UNCATEGORIZED_CATEGORY).toBe('');
    expect(UNCATEGORIZED_LABEL).toBe('未分类');
  });

  // 0925 拍板四：「开学季」删出词表——三层面（web 数组 / api 数组 / 0017 CHECK）都不许再有它。
  it('「开学季」已删出词表（12 → 11），且 web/api/0017 迁移 CHECK 三方逐项一致', () => {
    expect(SKILL_CATEGORIES).not.toContain('开学季');
    expect(parseApiSkillCategories()).not.toContain('开学季');
    expect(parseMigration0017CheckCategories()).toEqual([...SKILL_CATEGORIES]);
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

  it('每个模板的 category 都在 11 词表内且不是未分类 \'\'（模板当范用，不许示范错误用法）', () => {
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
  it('词表内值原样采纳（11 词逐一）', () => {
    for (const value of SKILL_CATEGORIES) {
      expect(toSkillCategory(value)).toBe(value);
    }
  });

  it('词表外值（含旧包把 category 写成类型枚举值）与空串一律落未分类 \'\'、不报错', () => {
    // 「开学季」0925 拍板四起是越表值：导入归一必须落 ''（与旧包类型枚举同路径）。
    for (const raw of ['', 'workflow', 'flow', 'prompt', '官方', '开学季', ' 质量保障', '质量保障 ']) {
      expect(toSkillCategory(raw), `raw=${JSON.stringify(raw)}`).toBe('');
    }
  });
});
