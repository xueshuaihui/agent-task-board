-- 技能 tags 存量洗数收紧（0925 拍板：「标签是标签，分类是分类」，tags 只保留自由标签）。
--
-- 为什么再来一刀：0015 的洗 tags 段只剔受众词与被 category 取走的那一个词，词表内的「第二
-- 分类词」被判定留在 tags 无害（85b0d44 回退说明）。真机实测推翻：94 条内置技能里 43 条的
-- tags 仍残留词表词（开学季×29、Office办公×4、资讯研究×3、推荐×3、开发编程×2、投资理财×2、
-- 数据分析×1），且这 43 条的 tags 仅此一词——卡片同时显示分类徽标和一模一样的标签，同一技能
-- 呈现两套分类标准的观感。残留词表词经前端 skill-card 的标签区（tags.slice(0, 3)）与
-- skill-search 的 tags 命中面都会把它再呈现成「第二个分类」，留着并非无害。新口径：
-- **tags 中不得出现任何 12 词表词，也不得出现受众词 官方/社区，其余原序保留**。
-- 内置洗后大量条目 tags 为空数组，这是预期终态（绑定技能搜索不受影响：category 是独立命中面）。
--
-- 1) 范围：**存量所有行**（default/custom/imported 一律同口径，统一口径最稳，不按
--    source_type 分叉）。写入侧（create/patch）行为不动，词表词进 tags 由本迁移与
--    导入路径的 freeTagsOf（src/skills/skill-categories.ts，已同步收紧）兜住。
-- 2) 写法照 0015：json_each 展开 + json_group_array 按 j.key 重组，数组原序不变；
--    只重写真正命中的行，tags 非法 JSON 或非数组的行原样留着，不做格式归一化。
--    空串元素不在本迁移剔除范围（0015 也没剔；导入侧由 length>0 过滤兜底）。
-- 3) 不改 updated_at：洗数是数据归位而非用户编辑（0009/0015 同口径）。
-- 4) seed 侧同步：gen-builtin-seeds.mjs 与 builtin-skills.data.*.ts 已按新口径重生成，
--    ensureDefaultSkills 每次启动整份 upsert 的正是洗后终值，不会再灌回词表词。
-- 5) 0015 文件已随包定稿、不改；本迁移覆盖其洗数结果，两侧「被 category 取走的词」
--    与「第二个词表词」在本迁移的 12 词表 IN 列表里一并剔掉。
-- 本文件与 0001~0015 一样是权威 DDL（纯洗数，无 schema 变更），不要用 `prisma migrate dev` 重算。

UPDATE skills
SET tags = (
  SELECT json_group_array(t.value)
  FROM (
    SELECT j.value AS value
    FROM json_each(skills.tags) AS j
    WHERE j.value NOT IN ('官方', '社区')
      AND j.value NOT IN ('开学季','教育学习','投资理财','方案写作','内容创作','推荐',
                          'Office办公','实用工具','数据分析','开发编程','资讯研究','质量保障')
    ORDER BY j.key
  ) AS t
)
WHERE json_valid(skills.tags)
  AND json_type(skills.tags, '$') = 'array'
  AND EXISTS (
    SELECT 1 FROM json_each(skills.tags) AS j
    WHERE j.value IN ('官方', '社区')
       OR j.value IN ('开学季','教育学习','投资理财','方案写作','内容创作','推荐',
                      'Office办公','实用工具','数据分析','开发编程','资讯研究','质量保障')
  );
