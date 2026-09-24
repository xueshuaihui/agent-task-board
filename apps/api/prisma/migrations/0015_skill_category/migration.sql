-- 技能分类收口（PRD §9.2 两字段模型）：skills 新增单值 `category` 列，`tags` 退回纯自由标签。
--
-- 为什么加这列：分类体系历史上从来没真正落地——skills 表从来没有 category 列（grep 全量迁移，
-- `category` 只存在于 0004/0006 的 market_listings，那张表已随 0007「市场下线」整表删除），
-- 于是三种语义灌进同一个 tags TEXT（JSON 数组字符串）：
--   ① 93 条千问迁移内置技能把「官方/社区」受众词塞在 tags[0]（生成器
--      apps/api/scripts/gen-builtin-seeds.mjs 按 catalog.source 折算）；
--   ② 剩下的 tags 被前端当分类用——apps/web/src/features/skills/meta.ts 的
--      CATEGORY_TAG_EXCLUDES=['官方','社区'] 靠「tags 去掉这两个词」的减法猜分类；
--   ③ tags 同时还是用户自由标签（PRD §9.2 样例 code-review 的 tags 就是 review/quality）。
-- 结果：分类是猜出来的，任何自由标签都会自动变成技能库分类筛选器里的一个选项（实测长出
-- review/quality 两个英文孤例）。收口口径：分类只有一套标准 = 本迁移新增的 category 列；
-- 「官方/社区」这个受众维度直接作废（不新增 audience 列，出处由已有 source_type 三来源表达），
-- 所以这两个词要从 tags 里洗掉、不留后路。
--
-- 1) 加列 + 约束 + 索引：`category TEXT NOT NULL DEFAULT ''`，词表 12 项收在列级 CHECK 里，
--    外加 idx_skills_category。与 0009（groups.is_default）/0011（groups.archived_at）同法：
--    SQLite 允许对「常量默认值 + CHECK」的列直接 ALTER ADD COLUMN（默认值 '' 本身在词表内，
--    存量行按默认值即合规），不牵动 skills 既有 CHECK、idx_skills_status 与 skill_versions 的
--    FK（ON DELETE CASCADE），因此**不做** 0007/0010/0014 那种整表重建——0014 重建丢
--    idx_notif_read 的风险在「不重建」这条路径上根本不存在。
--    '' 是合法值，语义为「未分类」（词表外/无分类词的技能就该是空，不造数）。
-- 2) 回填：category = 该行 tags 中第一个「不属于 {官方,社区} 且属于 12 词表」的词（tags 数组序
--    即 json_each 的 key 序），命不中则 ''。12 词表是硬筛而非兜底：自定义技能 tags 里的词表外
--    中文词**不得**进 category（会撞 CHECK）。
-- 3) 洗 tags：剔除 官方/社区 两个受众词，以及被 category 取走的那个词（同一语义不在两处冗余）；
--    其余自由标签连同原顺序一律原样保留（json_each 展开 + json_group_array 重组，数组序不变）。
--    刻意不给任何技能 id 写特例，两条被点名验证的内置技能都由通用规则自然得到：
--      skl_builtin_code-review   tags ["review","quality"] → 两词皆不在词表 → category ''、tags 原样；
--      skl_builtin_skill-creator tags ["官方"]             → 无分类词      → category ''、洗后 []
--        （它的 实用工具 由下一棒在 seed 侧显式补，本迁移不越俎代庖）。
-- 4) 不改 updated_at：回填与洗数是数据归位而非用户编辑（0009 同口径）。
-- 5) 不动 seed：apps/api/scripts/gen-builtin-seeds.mjs 与内置种子仍会产出 官方/社区，且
--    ensureDefaultSkills（apps/api/src/skills/default-skills.ts）每次启动把 seed 的 tags 整份
--    upsert 回库——经应用启动后 tags 会被重新灌回受众词，那是 seed 侧未收口的既有行为，
--    由下一棒（C-2）处理，本迁移只保证库内一次到位。
-- 本文件与 0001~0014 一样是权威 DDL（含 CHECK），不要用 `prisma migrate dev` 重算。

ALTER TABLE skills ADD COLUMN category TEXT NOT NULL DEFAULT ''
  CHECK (category IN ('',
    '开学季','教育学习','投资理财','方案写作','内容创作','推荐',
    'Office办公','实用工具','数据分析','开发编程','资讯研究','质量保障'));

CREATE INDEX idx_skills_category ON skills(category);

-- 回填：tags 非法 JSON 或非数组的行按空数组处理（category 落 ''，迁移不因脏数据整体回滚）。
UPDATE skills
SET category = COALESCE((
  SELECT j.value
  FROM json_each(
    CASE WHEN json_valid(skills.tags) AND json_type(skills.tags, '$') = 'array'
         THEN skills.tags ELSE '[]' END
  ) AS j
  WHERE j.value NOT IN ('官方', '社区', '')
    AND j.value IN ('开学季','教育学习','投资理财','方案写作','内容创作','推荐',
                    'Office办公','实用工具','数据分析','开发编程','资讯研究','质量保障')
  ORDER BY j.key
  LIMIT 1
), '');

-- 洗 tags：只重写真正需要动的行（脏数据/非数组行原样留着，不做格式归一化）。
UPDATE skills
SET tags = (
  SELECT json_group_array(t.value)
  FROM (
    SELECT j.value AS value
    FROM json_each(skills.tags) AS j
    WHERE j.value NOT IN ('官方', '社区')
      AND (skills.category = '' OR j.value <> skills.category)
    ORDER BY j.key
  ) AS t
)
WHERE json_valid(skills.tags)
  AND json_type(skills.tags, '$') = 'array'
  AND EXISTS (
    SELECT 1 FROM json_each(skills.tags) AS j
    WHERE j.value IN ('官方', '社区')
       OR (skills.category <> '' AND j.value = skills.category)
  );
