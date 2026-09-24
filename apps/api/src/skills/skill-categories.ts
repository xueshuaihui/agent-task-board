/**
 * 技能分类受控词表（v0.0.4 分类收口 C-2 + 0925 两级树化，PRD §9.2 两字段模型）。
 *
 * 为什么有本文件：分类体系历史上从来没有真正的落点——skills 只有 tags TEXT（JSON 数组字符串）
 * 一个字段，三种语义灌在里面（千问迁移的 93 条内置把「官方/社区」受众词塞 tags[0]、其余 tags
 * 被前端 apps/web/src/features/skills/meta.ts 用「tags 减去 官方/社区」的减法当分类、tags 同时
 * 还是用户自由标签），结果任何自由标签都会自动长成一个分类选项。收口口径：
 * - 分类只有一套标准 = skills.category 单值列（0015 迁移加列，CHECK 现行真值源在 0018），
 *   取值即下面的 16 项**叶子**词表（0925 树化拍板：7 个一级 / 16 个合法叶子 + `''`）；
 * - tags 退回纯自由标签：分类选项不再由 tags 推导（前端读本词表），且 tags 中不得再出现
 *   词表叶子词（六个产研阶段词除外，见下方双角色口径）、受众词或作废词；
 * - 「官方/社区」受众维度直接作废（不加 audience 列，出处由已有 source_type 三来源表达），
 *   所以 AUDIENCE_TAGS 里的词在写入侧与回填侧都要被剔除。
 *
 * 两级树（0925 拍板，权威见 docs/0925/二级分类草案.md §2 映射表）：
 * - 编码开发 / 办公实用 / 研究分析是**纯分组一级**——只是分组，不是合法 category 值，
 *   选了它们 = 422；教育学习 / 内容创作 / 方案写作 / 投资理财四个一级本身兼叶子（暂不设二级）；
 * - SKILL_CATEGORY_TREE 是唯一结构源，SKILL_CATEGORY_LEAVES 由树展平，
 *   SKILL_CATEGORIES 保留为叶子的兼容别名（下游 isSkillCategory/zod/freeTagsOf/生成器/
 *   web 镜像都从它派生）；
 * - **双角色阶段词（用户拍板的有意特例）**：需求与规划/开发与实现/质量与安全/代码清理/
 *   运维与协作/测试自动化 六个词既是「编码开发」下的二级叶子（category 值），又是合法的
 *   产研阶段自由标签（0925 编码技能收录时人工判定，逐条写在 docs/0925/coding-skills-catalog.json
 *   的 tags 里，卡片「分类徽标 + 同名标签」两行呈现是拍板接受的观感代价）。因此 freeTagsOf
 *   的剔除集合 = 受众词 ∪ (叶子 − 六阶段词) ∪ 作废词，不变量新口径为
 *   **tags ∩ (叶子 − 阶段词) = ∅**（阶段词豁免；其余叶子词进 tags 仍一律洗掉）。
 *
 * 所有权：本文件由 C-2（seed 层收口）创建并维护，后续棒次（C-3 服务层/接口、前端）**只许
 * import、不许改动**——词表变动走「新迁移 + 同步这里」的流程（0925 树化即走的这条路：
 * 新迁移 0018 重建 skills 表收敛 16 叶子 CHECK、0019 回填内置行，0015/0016/0017 定稿不回改）。
 *
 * ⚠ 与迁移的关系（0925 树化后改口径）：**0018 迁移的列级 CHECK 是本数组的现行真值源**
 * （两边必须逐项一致，含顺序无关的字面完全一致；0018 重建 skills 表时把 CHECK 收成语句
 * 内联的 `'' + 16 叶子` IN 列表，拷贝前先把旧值「质量保障」直映射洗为「质量与安全」）。
 * 0015（12 词）/0017（11 词）的 CHECK 属历史定稿，fresh 全量重放里先落地、随后被 0018
 * 重建顶替，不再是校验依据。0019 把内置行（31 coding + code-review 样例 + Q3 三条千问）
 * 逐 id 回填到叶子终值，与 seed upsert 终值一致（fresh/增量两条路径收敛同一口径）。
 * categoryFromTags 的判定与「现行词表」同口径；0015 回填当年按 12 词取过「开学季」「质量保障」，
 * 前者由 0017 洗为 ''、后者由 0018 直映射为「质量与安全」，全量重放与增量升级的最终口径一致。
 */

/**
 * 两个「纯分组一级」（有 children 的一级）不是合法 category 值；教育学习/内容创作/
 * 方案写作/投资理财 children 为空，一级词本身即叶子。全集（一级 ∪ 二级）字面无重复。
 */
export const SKILL_CATEGORY_TREE = [
  {
    value: '编码开发',
    children: [
      '需求与规划',
      '开发与实现',
      '质量与安全',
      '代码清理',
      '运维与协作',
      '测试自动化',
      // 过渡二级（0925 Q1 拍板保留）：千问 5 条存量零迁移；后续批再细分。
      '开发编程',
    ],
  },
  { value: '教育学习', children: [] },
  { value: '内容创作', children: [] },
  { value: '方案写作', children: [] },
  { value: '投资理财', children: [] },
  { value: '办公实用', children: ['Office办公', '实用工具'] },
  { value: '研究分析', children: ['数据分析', '资讯研究', '推荐'] },
] as const;

/**
 * 16 项叶子词表（0925 树化：11 → 16，删「质量保障」、增六个阶段词）：与 0018 CHECK 逐项一致，
 * 也是 SKILL_CATEGORY_TREE 展平结果——两份字面的一致性由 builtin-skills.test ⑥ 锁死
 * （api 文件 / 生成器数组 / 0018 CHECK 三方字面比对同口径），飘了即红。
 */
export const SKILL_CATEGORIES = [
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
  '需求与规划',
  '开发与实现',
  '质量与安全',
  '代码清理',
  '运维与协作',
  '测试自动化',
] as const;

/** 树展平的可取值集（16 词）：与 SKILL_CATEGORIES 同物异名，两级语境下读名字更直白。 */
export const SKILL_CATEGORY_LEAVES: readonly SkillCategory[] = SKILL_CATEGORIES;

/**
 * 六个产研阶段词（「编码开发」下的二级叶子）。**双角色特例（0925 用户拍板）**：它们既是
 * category 叶子值，又合法保留在 coding 内置的 tags 里作产研阶段标签——freeTagsOf 对它们
 * 豁免不洗。除这六个之外的任何叶子词进 tags 仍一律剔除（不变量：tags ∩ (叶子 − 阶段词) = ∅）。
 */
export const STAGE_CATEGORY_TERMS = [
  '需求与规划',
  '开发与实现',
  '质量与安全',
  '代码清理',
  '运维与协作',
  '测试自动化',
] as const;

export type SkillCategory = (typeof SKILL_CATEGORIES)[number];

/** 一级词全集（7 个，含三个纯分组一级）：不是 category 取值，只服务筛选栏/文案两级呈现。 */
export const SKILL_TOP_CATEGORIES = SKILL_CATEGORY_TREE.map((top) => top.value) as unknown as TopCategory[];

export type TopCategory = (typeof SKILL_CATEGORY_TREE)[number]['value'];

/**
 * 「未分类」= 空串：category 列的默认值与合法值（0015 `DEFAULT ''`）。
 * 词表外/无分类词的技能就该落这里，不造数；但内置种子不允许未分类
 * （生成器有构建期校验，见 scripts/gen-builtin-seeds.mjs）。
 */
export const UNCATEGORIZED = '' as const;
export type SkillCategoryOrNone = SkillCategory | typeof UNCATEGORIZED;

/** 已作废的受众词：只作为「洗数时要剔除的词」保留，不再写进任何字段。 */
export const AUDIENCE_TAGS = ['官方', '社区'] as const;

/**
 * 已作废的历史词表词：不再是分类取值，但**同样禁止**以自由标签身份回流 tags——
 * - 「开学季」（0925 拍板四删词）：上游 catalog 31 条内置的 tags 带它，只按现行词表洗
 *   会让它重新灌进分片 tags（卡片又长出「分类徽标 + 同款标签」的旧毛病），0016 已把库内
 *   tags 洗掉，本集合接续这个口径。
 * - 「质量保障」（0925 树化作废）：旧 11 词里的编码批次桶，125 条内置实测 15 行全部按
 *   §2 映射表逐条改判到六个阶段叶子；用户行旧值由 0018 拷贝前直映射「质量与安全」（Q4），
 *   导入侧不做 compat（Q5：词表外一律归 ''），所以它以作废词身份继续被 freeTagsOf 剔除。
 */
export const RETIRED_CATEGORY_TERMS = ['开学季', '质量保障'] as const;

const CATEGORY_SET: ReadonlySet<string> = new Set<string>(SKILL_CATEGORIES);
const TOP_SET: ReadonlySet<string> = new Set<string>(SKILL_TOP_CATEGORIES);
const STAGE_SET: ReadonlySet<string> = new Set<string>(STAGE_CATEGORY_TERMS);
const AUDIENCE_SET: ReadonlySet<string> = new Set<string>(AUDIENCE_TAGS);
const RETIRED_SET: ReadonlySet<string> = new Set<string>(RETIRED_CATEGORY_TERMS);

/**
 * freeTagsOf 的剔除集合 = 受众词 ∪ (叶子 − 六阶段词) ∪ 作废词。
 * 六个阶段词是双角色豁免词（STAGE_CATEGORY_TERMS 注释有拍板依据）：既是分类叶子又是
 * 合法产研阶段标签，**有意特例**，不是漏洗。
 */
const FREE_TAG_PURGE_SET: ReadonlySet<string> = new Set<string>([
  ...AUDIENCE_TAGS,
  ...SKILL_CATEGORIES.filter((category) => !STAGE_SET.has(category)),
  ...RETIRED_CATEGORY_TERMS,
]);

/** 是否词表内的分类叶子（空串=未分类，不算词表分类；纯分组一级词返回 false）。 */
export function isSkillCategory(value: string): value is SkillCategory {
  return CATEGORY_SET.has(value);
}

/** 叶子判定（与 isSkillCategory 同语义，两级语境下读调用处更直白）。 */
export function isLeafCategory(value: string): value is SkillCategory {
  return CATEGORY_SET.has(value);
}

/** 是否一级词（含三个纯分组一级与四个一级兼叶子）。 */
export function isTopCategory(value: string): value is TopCategory {
  return TOP_SET.has(value);
}

/**
 * 叶子 → 所属一级。一级本身兼叶子的（教育学习等）返回自身；纯分组一级词与词表外值返回 null。
 * 前端筛选栏两级收拢与文案分组用这个函数，不要在调用方再抄一份映射。
 */
export function parentOfCategory(leaf: string): TopCategory | null {
  const top = SKILL_CATEGORY_TREE.find((item) => item.value === leaf);
  if (top) return top.value;
  const group = SKILL_CATEGORY_TREE.find((item) =>
    (item.children as readonly string[]).includes(leaf),
  );
  return group ? group.value : null;
}

/** 空串=未分类的语义判断（列表筛选器、只读校验用）。 */
export function isUncategorized(value: string): value is typeof UNCATEGORIZED {
  return value === UNCATEGORIZED;
}

/**
 * 从一组（历史）tags 里取分类词——与 0015 回填 SQL 同法、按**现行词表**判定：
 * 「tags 数组序中第一个不属于 {官方,社区} 且属于 16 叶子词表的词」，命不中则 ''（未分类）。
 * 迁移侧：`SELECT j.value FROM json_each(tags) ... WHERE j.value NOT IN ('官方','社区','')
 *  AND j.value IN (词表) ORDER BY j.key LIMIT 1`。0015 当年按 12 词取过「开学季」「质量保障」，
 * 前者由 0017 洗为 ''、后者由 0018 直映射「质量与安全」，两侧最终口径与本函数一致。
 * 口径不变的另一层依据：千问源 tags 永不含阶段词，词表含阶段词后它对千问源结果不变。
 */
export function categoryFromTags(tags: readonly string[]): SkillCategoryOrNone {
  for (const tag of tags) {
    if (!tag || AUDIENCE_SET.has(tag)) continue;
    if (CATEGORY_SET.has(tag)) return tag as SkillCategory;
  }
  return UNCATEGORIZED;
}

/**
 * 洗自由标签（**0925 树化后的新口径**，与 0016 洗数段的关系见下）：
 * 「标签是标签，分类是分类」——剔除集合 = 受众词 ∪ (16 叶子 − 六个阶段词) ∪ 作废词
 * （RETIRED_CATEGORY_TERMS 注释有逐词理由），只剔这几类词，**其余原序保留**。
 * 阶段词豁免是用户拍板的有意特例（双角色：既是「编码开发」二级叶子又是合法产研阶段标签，
 * 31 条 coding 内置的 tags 逐条带它们，卡片两行呈现是接受的特例）；
 * 不变量：**tags ∩ (叶子 − 阶段词) = ∅**。
 * 内置终态：93 条千问 tags 仍为空数组（其 tags 本就是受众词+分类词，永不含阶段词）、
 * 31 条 coding 原样带阶段标签、code-review 样例保持 review/quality。
 *
 * 旧口径沿革（0925 拍板收紧、第四片删「开学季」）：「只剔被 category 取走的那一个词」已被
 * 真机实测推翻（43 条内置 tags 残留词表词、卡片两套分类观感，见 85b0d44 回退说明），
 * 0016 按当时 12 词把库内 tags 洗净；本函数与其差异只在阶段词豁免——阶段词历史上从未进过
 * 词表、0016 没洗过它们，本次是「继续不洗」。用户 custom 行的阶段词标签**不升格**为分类
 * （分类只在 category 列），它留在 tags 里就是普通自由标签。
 */
export function freeTagsOf(tags: readonly string[]): string[] {
  return tags.filter((tag) => !FREE_TAG_PURGE_SET.has(tag));
}
