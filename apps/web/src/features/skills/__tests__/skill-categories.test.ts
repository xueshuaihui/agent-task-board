import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import * as skillMeta from '../meta';
import {
  RETIRED_CATEGORY_TERMS,
  SKILL_CATEGORIES,
  SKILL_CATEGORY_OPTIONS,
  SKILL_CATEGORY_TREE,
  SKILL_STARTER_TEMPLATES,
  SKILL_TOP_CATEGORIES,
  STAGE_CATEGORY_TERMS,
  UNCATEGORIZED_CATEGORY,
  UNCATEGORIZED_LABEL,
  isLeafCategory,
  isTopCategory,
  leavesOfTopCategory,
  parentOfCategory,
} from '../meta';
import { toSkillCategory } from '../markdown';
import type { SkillCategory, TopCategory } from '../types';

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
 * 0925 拍板四：词表 12 → 11（删「开学季」），并新增第三层比对——api 数组字面量与
 * 迁移重建 skills 表时的列级 CHECK IN 列表逐项一致。
 *
 * 0925 树化（本片）追加：比对从「单清单」改「树 + 叶子」双清单逐字比对——
 * api 的 SKILL_CATEGORY_TREE / SKILL_CATEGORIES / STAGE_CATEGORY_TERMS /
 * RETIRED_CATEGORY_TERMS 四个导出均须与 web 镜像一致；CHECK 真值源从 0017 换到
 * 0018（两级 16 叶子）。三个纯分组一级（编码开发/办公实用/研究分析）与作废词
 * 「质量保障」都不许出现在叶子表 / CHECK / options 取值集里。
 */

const here = path.dirname(fileURLToPath(import.meta.url));
/** apps/web 包根：__tests__ → skills → features → src → web。 */
const webRoot = path.resolve(here, '../../../..');
const apiSourceFile = path.join(webRoot, '../api/src/skills/skill-categories.ts');
const metaSourceFile = path.join(here, '../meta.ts');
/** 0018 迁移：skills 表整表重建后的列定义里挂着 category CHECK 的现行真值源（0017 已被顶替）。 */
const migration0018File = path.join(
  webRoot,
  '../api/prisma/migrations/0018_skill_category_tree/migration.sql',
);

/** 从 api 源文件抽 `export const NAME = [...] as const` 的数组字面量（按序，仅字符串项）。 */
function parseApiArray(name: string): string[] {
  const source = readFileSync(apiSourceFile, 'utf8');
  const declaration = new RegExp(`export const ${name}\\s*=\\s*\\[([\\s\\S]*?)\\]`).exec(source);
  expect(declaration, `api skill-categories.ts 里应存在 ${name} 数组声明`).not.toBeNull();
  return [...declaration![1].matchAll(/'([^']*)'/g)].map((match) => match[1]);
}

/** 从 api 源文件抽 SKILL_CATEGORY_TREE 的字面结构（顶级顺序 + 各组 children 顺序）。 */
function parseApiTree(): { value: string; children: string[] }[] {
  const source = readFileSync(apiSourceFile, 'utf8');
  const declaration =
    /export const SKILL_CATEGORY_TREE\s*=\s*\[([\s\S]*?)\n\]\s*as\s*const/.exec(source);
  expect(declaration, 'api skill-categories.ts 里应存在 SKILL_CATEGORY_TREE 声明').not.toBeNull();
  const items = [
    ...declaration![1].matchAll(
      /\{\s*value:\s*'([^']+)'(?:,\s*children:\s*\[([\s\S]*?)\],?)?\s*\}/g,
    ),
  ];
  expect(items.length, 'SKILL_CATEGORY_TREE 顶级应恰有 7 项').toBe(7);
  return items.map((match) => ({
    value: match[1],
    children: match[2] ? [...match[2].matchAll(/'([^']*)'/g)].map((word) => word[1]) : [],
  }));
}

/** 抽 0018 迁移里 category CHECK 的 IN 列表（去掉 ''=未分类，只留词表词，按序）。 */
function parseMigration0018CheckCategories(): string[] {
  const source = readFileSync(migration0018File, 'utf8');
  const declaration =
    /category\s+TEXT NOT NULL DEFAULT ''\s+CHECK \(category IN \(([^)]*)\)\)/.exec(source);
  expect(declaration, '0018 迁移里应存在带 CHECK 的 category 列定义').not.toBeNull();
  return [...declaration![1].matchAll(/'([^']*)'/g)]
    .map((match) => match[1])
    .filter((value) => value !== '');
}

/** 三个「纯分组一级」（有 children 的一级）：不是合法 category 值。 */
const GROUP_ONLY_TOPS = ['编码开发', '办公实用', '研究分析'];

describe('skill category 两级词表（web ↔ api 单一事实源）', () => {
  it('web 叶子词表与 api SKILL_CATEGORIES 逐字等值且顺序一致', () => {
    expect([...SKILL_CATEGORIES]).toEqual(parseApiArray('SKILL_CATEGORIES'));
  });

  it('web SKILL_CATEGORY_TREE 与 api 树逐字同构（顶级顺序 + children 顺序）', () => {
    expect(SKILL_CATEGORY_TREE).toEqual(parseApiTree());
  });

  it('web STAGE_CATEGORY_TERMS / RETIRED_CATEGORY_TERMS 与 api 逐字等值且顺序一致', () => {
    expect([...STAGE_CATEGORY_TERMS]).toEqual(parseApiArray('STAGE_CATEGORY_TERMS'));
    expect([...RETIRED_CATEGORY_TERMS]).toEqual(parseApiArray('RETIRED_CATEGORY_TERMS'));
  });

  it('叶子恰为 16 项、无空串/重复；树展平（多重集）== 叶子全集；一级词表内无重复', () => {
    expect(SKILL_CATEGORIES).toHaveLength(16);
    expect(new Set(SKILL_CATEGORIES).size).toBe(16);
    expect(SKILL_CATEGORIES).not.toContain('');
    const flattened = SKILL_CATEGORY_TREE.flatMap((top) =>
      top.children.length > 0 ? [...top.children] : [top.value],
    );
    expect([...flattened].sort()).toEqual([...SKILL_CATEGORIES].sort());
    expect(new Set(flattened).size).toBe(16);
    expect(SKILL_TOP_CATEGORIES).toHaveLength(7);
    expect(new Set(SKILL_TOP_CATEGORIES).size).toBe(7);
    // 一级∪叶子字面无重复 ⇔ children 为空的一级本身即叶子、纯分组一级不进叶子表。
    for (const top of SKILL_CATEGORY_TREE) {
      expect(SKILL_CATEGORIES.includes(top.value as SkillCategory)).toBe(top.children.length === 0);
    }
    for (const group of GROUP_ONLY_TOPS) expect(SKILL_CATEGORIES).not.toContain(group);
    expect(UNCATEGORIZED_CATEGORY).toBe('');
    expect(UNCATEGORIZED_LABEL).toBe('未分类');
  });

  it('作废词「开学季」「质量保障」三层面（web 叶子 / api 叶子 / 0018 CHECK）都不许有', () => {
    expect(parseApiArray('SKILL_CATEGORIES')).not.toContain('开学季');
    expect(parseApiArray('SKILL_CATEGORIES')).not.toContain('质量保障');
    expect(SKILL_CATEGORIES).not.toContain('质量保障');
    expect(parseMigration0018CheckCategories()).toEqual([...SKILL_CATEGORIES]);
    expect(parseMigration0018CheckCategories()).not.toContain('质量保障');
  });

  it('阶段词双角色：六词既是「编码开发」叶子又镜像 api STAGE_CATEGORY_TERMS', () => {
    const coding = SKILL_CATEGORY_TREE.find((top) => top.value === '编码开发');
    expect(coding).toBeDefined();
    for (const stage of STAGE_CATEGORY_TERMS) {
      expect(coding!.children).toContain(stage);
      expect(SKILL_CATEGORIES).toContain(stage);
      // 双角色口径：阶段词是词表叶子，web 侧 freeTags 剔除归 api 服务端；这里只锁词面归属。
      expect(parentOfCategory(stage)).toBe('编码开发');
    }
    expect(STAGE_CATEGORY_TERMS).toHaveLength(6);
  });
});

describe('两级派生工具（parentOf / leavesOf / 判定）', () => {
  it('叶子 → 所属一级：一级兼叶子返回自身，纯分组一级与词表外值（含 \'\'）返回 null', () => {
    expect(parentOfCategory('需求与规划')).toBe('编码开发');
    expect(parentOfCategory('开发编程')).toBe('编码开发');
    expect(parentOfCategory('Office办公')).toBe('办公实用');
    expect(parentOfCategory('推荐')).toBe('研究分析');
    expect(parentOfCategory('教育学习')).toBe('教育学习');
    expect(parentOfCategory('内容创作')).toBe('内容创作');
    for (const group of GROUP_ONLY_TOPS) expect(parentOfCategory(group)).toBeNull();
    expect(parentOfCategory('')).toBeNull();
    expect(parentOfCategory('质量保障')).toBeNull();
  });

  it('isLeafCategory / isTopCategory 与 api 同口径', () => {
    for (const leaf of SKILL_CATEGORIES) expect(isLeafCategory(leaf)).toBe(true);
    expect(isLeafCategory('编码开发')).toBe(false);
    expect(isLeafCategory('质量保障')).toBe(false);
    expect(isLeafCategory('')).toBe(false);
    for (const top of SKILL_TOP_CATEGORIES) expect(isTopCategory(top)).toBe(true);
    expect(isTopCategory('需求与规划')).toBe(false);
  });

  it('leavesOfTopCategory：纯分组一级给全部子叶，一级兼叶子给自身；与 parentOf 互为逆', () => {
    expect([...leavesOfTopCategory('编码开发')]).toEqual([
      '需求与规划',
      '开发与实现',
      '质量与安全',
      '代码清理',
      '运维与协作',
      '测试自动化',
      '开发编程',
    ]);
    expect([...leavesOfTopCategory('教育学习')]).toEqual(['教育学习']);
    for (const top of SKILL_TOP_CATEGORIES) {
      for (const leaf of leavesOfTopCategory(top)) expect(parentOfCategory(leaf)).toBe(top);
    }
  });
});

describe('SKILL_CATEGORY_OPTIONS（编辑器/创建向导单选，两级呈现）', () => {
  it('取值集恒为 16 叶 + 未分类：纯分组一级与作废词不进取值集，未分类排最后', () => {
    const values = SKILL_CATEGORY_OPTIONS.map((option) => option.value);
    expect(values).toHaveLength(17);
    expect(new Set(values).size).toBe(17);
    expect(values[values.length - 1]).toBe('');
    for (const value of values) {
      expect(value === '' || isLeafCategory(value), `value=${value}`).toBe(true);
    }
    for (const group of GROUP_ONLY_TOPS) expect(values).not.toContain(group);
    expect(values).not.toContain('质量保障');
  });

  it('group 组头只允许纯分组一级，且与树的从属关系一致；一级兼叶子无组头', () => {
    const groupTops = SKILL_CATEGORY_TREE.filter((top) => top.children.length > 0).map(
      (top) => top.value,
    );
    expect(groupTops).toEqual(GROUP_ONLY_TOPS);
    for (const option of SKILL_CATEGORY_OPTIONS) {
      if (!option.group) continue;
      expect(GROUP_ONLY_TOPS).toContain(option.group);
      expect(leavesOfTopCategory(option.group as TopCategory)).toContain(option.value);
      expect(parentOfCategory(option.value)).toBe(option.group);
    }
    expect(SKILL_CATEGORY_OPTIONS.find((o) => o.value === '教育学习')?.group).toBeUndefined();
    expect(SKILL_CATEGORY_OPTIONS.find((o) => o.value === '需求与规划')?.group).toBe('编码开发');
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

  it('每个模板的 category 都在 16 叶子词表内且不是未分类 \'\'（模板当范用，不许示范错误用法）', () => {
    for (const template of SKILL_STARTER_TEMPLATES) {
      expect(
        SKILL_CATEGORIES,
        `模板 ${template.id} 的 category「${template.category}」不在词表内`,
      ).toContain(template.category);
      expect(template.category, `模板 ${template.id} 不许用未分类 '' 蒙混`).not.toBe('');
    }
  });
});

describe('frontmatter category 归一 toSkillCategory（与 api 导入口径一致，Q5-D）', () => {
  it('词表内值原样采纳（16 叶逐一）', () => {
    for (const value of SKILL_CATEGORIES) {
      expect(toSkillCategory(value)).toBe(value);
    }
  });

  it('词表外值一律落未分类 \'\'、不报错：类型枚举值、受众词、作废词（开学季/质量保障）、三个纯分组一级', () => {
    const outside = [
      '',
      'workflow',
      'flow',
      'prompt',
      '官方',
      '开学季',
      '质量保障',
      ' 质量保障',
      '质量保障 ',
      '编码开发',
      '办公实用',
      '研究分析',
    ];
    for (const raw of outside) {
      expect(toSkillCategory(raw), `raw=${JSON.stringify(raw)}`).toBe('');
    }
  });

  it('一级兼叶子的词（内容创作）仍是合法取值，直收不误伤', () => {
    expect(toSkillCategory('内容创作')).toBe('内容创作');
  });
});
