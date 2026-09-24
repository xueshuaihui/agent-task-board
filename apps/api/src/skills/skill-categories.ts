/**
 * 技能分类受控词表（v0.0.4 分类收口 C-2，PRD §9.2 两字段模型）。
 *
 * 为什么有本文件：分类体系历史上从来没有真正的落点——skills 只有 tags TEXT（JSON 数组字符串）
 * 一个字段，三种语义灌在里面（千问迁移的 93 条内置把「官方/社区」受众词塞 tags[0]、其余 tags
 * 被前端 apps/web/src/features/skills/meta.ts 用「tags 减去 官方/社区」的减法当分类、tags 同时
 * 还是用户自由标签），结果任何自由标签都会自动长成一个分类选项。收口口径：
 * - 分类只有一套标准 = skills.category 单值列（0015 迁移），取值即下面的 12 项词表；
 * - tags 退回纯自由标签，不再承载分类语义；
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
 * 洗自由标签：剔除作废的受众词，并剔除**任何**词表词（分类语义不再进 tags，见文件头）。
 *
 * 与 0015 洗 tags 段的关系：那里只剔「被 category 取走的那一个词」（`j.value <> category`），
 * 因为通用 SQL 不该顺手改用户自定义技能里恰好撞词表的自由标签；这里是 seed/写入侧，口径**更严**
 * ——内置技能的一条都不留。两侧同时成立的机制是：ensureDefaultSkills 每次启动用 seed 的 tags
 * 整份覆盖 94 条内置行，所以库内最终 tags 既无受众词也无词表词（本棒验收看的就是这个终值）。
 * 其余词原顺序保留。
 */
export function freeTagsOf(tags: readonly string[]): string[] {
  return tags.filter((tag) => !AUDIENCE_SET.has(tag) && !CATEGORY_SET.has(tag));
}
