/**
 * 技能分类受控词表（v0.0.4 分类收口 C-2，PRD §9.2 两字段模型）。
 *
 * 为什么有本文件：分类体系历史上从来没有真正的落点——skills 只有 tags TEXT（JSON 数组字符串）
 * 一个字段，三种语义灌在里面（千问迁移的 93 条内置把「官方/社区」受众词塞 tags[0]、其余 tags
 * 被前端 apps/web/src/features/skills/meta.ts 用「tags 减去 官方/社区」的减法当分类、tags 同时
 * 还是用户自由标签），结果任何自由标签都会自动长成一个分类选项。收口口径：
 * - 分类只有一套标准 = skills.category 单值列（0015 迁移），取值即下面的 12 项词表；
 * - tags 退回纯自由标签：分类选项不再由 tags 推导（前端读本词表），且 tags 中不得再出现
 *   任何词表词/受众词（0925 拍板收紧，0016 迁移洗存量，见 freeTagsOf 注释）；
 * - 「官方/社区」受众维度直接作废（不加 audience 列，出处由已有 source_type 三来源表达），
 *   所以 AUDIENCE_TAGS 里的词在写入侧与回填侧都要被剔除。
 *
 * 所有权：本文件由 C-2（seed 层收口）创建并维护，后续棒次（C-3 服务层/接口、前端）**只许
 * import、不许改动**——词表若真要变，走一条新的迁移改 0015 的 CHECK 并同步这里。
 *
 * ⚠ 与迁移的关系：0015 的列级 CHECK 与本数组必须逐项一致（含顺序无关的字面完全一致）；
 * categoryFromTags 的判定与 0015 回填 SQL 同口径（见函数注释）。两边飘了以本文件为准，
 * 并同步修迁移文件的注释（CHECK 本身属 prisma/** 定稿、由独立评审改）。
 */

/** 12 项受控分类词表：与 0015 迁移 category CHECK 的 IN 列表逐项一致。 */
export const SKILL_CATEGORIES = [
  '开学季',
  '教育学习',
  '投资理财',
  '方案写作',
  '内容创作',
  '推荐',
  'Office办公',
  '实用工具',
  '数据分析',
  '开发编程',
  '资讯研究',
  '质量保障',
] as const;

export type SkillCategory = (typeof SKILL_CATEGORIES)[number];

/**
 * 「未分类」= 空串：category 列的默认值与合法值（0015 `DEFAULT ''`）。
 * 词表外/无分类词的技能就该落这里，不造数；但内置种子不允许未分类
 * （生成器有构建期校验，见 scripts/gen-builtin-seeds.mjs）。
 */
export const UNCATEGORIZED = '' as const;
export type SkillCategoryOrNone = SkillCategory | typeof UNCATEGORIZED;

/** 已作废的受众词：只作为「洗数时要剔除的词」保留，不再写进任何字段。 */
export const AUDIENCE_TAGS = ['官方', '社区'] as const;

const CATEGORY_SET: ReadonlySet<string> = new Set<string>(SKILL_CATEGORIES);
const AUDIENCE_SET: ReadonlySet<string> = new Set<string>(AUDIENCE_TAGS);

/** 是否词表内的分类（空串=未分类，不算词表分类）。 */
export function isSkillCategory(value: string): value is SkillCategory {
  return CATEGORY_SET.has(value);
}

/** 空串=未分类的语义判断（列表筛选器、只读校验用）。 */
export function isUncategorized(value: string): value is typeof UNCATEGORIZED {
  return value === UNCATEGORIZED;
}

/**
 * 从一组（历史）tags 里取分类词——**必须与 0015 回填 SQL 的判定完全一致**：
 * 「tags 数组序中第一个不属于 {官方,社区} 且属于 12 词表的词」，命不中则 ''（未分类）。
 * 迁移侧：`SELECT j.value FROM json_each(tags) ... WHERE j.value NOT IN ('官方','社区','')
 *  AND j.value IN (词表) ORDER BY j.key LIMIT 1`；两侧任一改动都要同步另一侧。
 */
export function categoryFromTags(tags: readonly string[]): SkillCategoryOrNone {
  for (const tag of tags) {
    if (!tag || AUDIENCE_SET.has(tag)) continue;
    if (CATEGORY_SET.has(tag)) return tag as SkillCategory;
  }
  return UNCATEGORIZED;
}

/**
 * 洗自由标签（**0925 拍板收紧后的新口径**，存量由 0016 迁移按同口径洗）：
 * 「标签是标签，分类是分类」——tags 中不得出现任何 12 词表词，也不得出现受众词 官方/社区，
 * 只剔这两类词，**其余原序保留**。内置种子洗后大量条目 tags 为空数组，这是预期终态。
 *
 * 旧口径（「只剔被 category 取走的那一个词、词表内第二个分类词留在 tags 无害」，见 85b0d44
 * 回退说明）已被真机实测推翻：94 条内置里 43 条 tags 残留词表词、且这些 tags 仅此一词，
 * 卡片同时显示分类徽标和一模一样的标签——同一技能呈现两套分类标准的观感。残留词表词经
 * `apps/web/src/features/skills/skill-card.tsx` 的标签区（tags.slice(0, 3)）与
 * skill-search 的 tags 命中面都会把它再呈现成「第二个分类」，留着并非无害。
 * 绑定技能的模糊搜索不受影响：category 本身就是独立命中面（skill-search 的 category 字段）。
 *
 * 与 0016 洗数段同口径（`apps/api/prisma/migrations/0016_skill_tags_purge/migration.sql`
 * 的 `j.value NOT IN ('官方','社区', 12 词表)`）；0015 洗 tags 段的「只剔被取走的词」口径
 * 已被 0016 覆盖，0015 文件定稿不改。
 */
export function freeTagsOf(tags: readonly string[]): string[] {
  return tags.filter((tag) => !AUDIENCE_SET.has(tag) && !CATEGORY_SET.has(tag));
}
