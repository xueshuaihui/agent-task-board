-- 技能分类收口（0925 拍板）：受控分类词表删「开学季」，12 项 → 11 项。
-- 「开学季」是季节/运营占位词而非能力分类，且库内实测 0 行 category='开学季'
-- （0925 纠偏已把仅有的两条 code-mentor/deep-research 改判内容词，经 seed upsert 收敛）——
-- 纯词表 + schema 面变更，不动任何业务行的分类值。
--
-- 为什么必须整表重建：SQLite 的列级 CHECK 长在表定义里，0015 是 `ALTER TABLE ADD COLUMN`
-- 挂上去的，改词表无法就地改 CHECK——按 0005/0007/0008/0010/0014 先例重建 skills：
-- 新表 skills_new 带 11 词 CHECK → INSERT SELECT 全量拷贝 → DROP 旧表 → RENAME 顶替
-- → 重建 skills 上全部索引（idx_skills_status、idx_skills_category）。
-- skill_versions 的 REFERENCES 一直指向字面量 skills：DROP 发生在外键关闭期间
-- （不做隐式 DELETE 级联、不丢版本行），RENAME 顶替 vacated 的名字后引用自动落到新表，
-- ON DELETE CASCADE 语义原样保留（同 0010 关键注释）。
-- 外键 pragma 的处理照 bootstrap.ts：迁移执行器（src/infra/bootstrap.ts）在 BEGIN 之前
-- 已在连接上 `PRAGMA foreign_keys = OFF`（该 pragma 无法在事务内切换），COMMIT 后恢复；
-- 本文件的 PRAGMA 行与 0010 一样只是自描述姿态，事务内实际是 no-op，不构成第二重保障。
--
-- 0015/0016 定稿不改：0015 的 12 词 CHECK 与「取走开学季」的回填只作历史口径，fresh
-- 全量重放里它们先照旧落地，本迁移随后收敛——两条路径（增量升级 / fresh 重放）终值一致。
--
-- 1) 防御性洗数（实测应为 0 行，留作 fresh 重放保险）：历史回填理论上仍可经 0015 的
--    12 词表把 tags 里的「开学季」取进 category，拷贝前统一落 ''（未分类），
--    否则 INSERT SELECT 会撞新 CHECK 炸整个迁移。tags 侧无需再洗：0016 已把
--    「开学季」连同其余 12 词表词从 tags 剔净，且「开学季」已进 freeTagsOf 的
--    作废词剔除集合（RETIRED_CATEGORY_TERMS），写入侧不会再回流。
-- 2) 不改 updated_at：洗数是数据归位而非用户编辑（0009/0015/0016 同口径）。
-- 3) 列定义逐字照 0010 重建后的形状 + 0015 的 category 列（仅 CHECK 的 IN 列表换成
--    11 词），列序与 0015 加列后一致（category 在最后），INSERT 用显式列清单不赌列序。
-- 本文件与 0001~0016 一样是权威 DDL（含 CHECK），不要用 `prisma migrate dev` 重算。

PRAGMA foreign_keys = OFF;

-- 1) 防御：词表外落点清零（见文件头）。必须在 INSERT 拷贝之前执行。
UPDATE skills SET category = '' WHERE category = '开学季';

CREATE TABLE skills_new (
  id               TEXT PRIMARY KEY,          -- 全局唯一、终身不变（r2），唯一性只由本列保证
  name             TEXT NOT NULL,             -- 允许重名（r2），不再建 UNIQUE
  type             TEXT NOT NULL
                     CHECK (type IN ('prompt','steps','flow','script','knowledge','composite','workflow')),
  status           TEXT NOT NULL DEFAULT 'DRAFT'
                     CHECK (status IN ('DRAFT','PUBLISHED','ARCHIVED')),
  description      TEXT NOT NULL DEFAULT '',
  tags             TEXT NOT NULL DEFAULT '[]',
  current_version  TEXT NOT NULL DEFAULT 'v0.1.0',
  content          TEXT NOT NULL DEFAULT '{"blocks":[],"entryBlockId":null}',
  mcp_dependencies TEXT NOT NULL DEFAULT '[]',
  test_cases       TEXT NOT NULL DEFAULT '[]',
  source_type      TEXT NOT NULL DEFAULT 'custom'
                     CHECK (source_type IN ('default','custom','imported')),
  created_at       TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at       TEXT NOT NULL DEFAULT (datetime('now')),
  -- 0015 加列（DEFAULT '' 不变）；CHECK 自本迁移起为 11 词现行词表，
  -- 与 src/skills/skill-categories.ts 的 SKILL_CATEGORIES 逐项一致（0925 拍板删「开学季」）。
  category         TEXT NOT NULL DEFAULT ''
                     CHECK (category IN ('',
                       '教育学习','投资理财','方案写作','内容创作','推荐',
                       'Office办公','实用工具','数据分析','开发编程','资讯研究','质量保障'))
);

INSERT INTO skills_new (
  id, name, type, status, description, tags, current_version, content,
  mcp_dependencies, test_cases, source_type, created_at, updated_at, category
)
SELECT
  id, name, type, status, description, tags, current_version, content,
  mcp_dependencies, test_cases, source_type, created_at, updated_at, category
FROM skills;

DROP TABLE skills;

-- 关键：skill_versions 的 REFERENCES 指向字面量 skills；RENAME 顶替后自动落到新表，
-- ON DELETE CASCADE 语义保住（同 0005/0010 先例）。
ALTER TABLE skills_new RENAME TO skills;

-- 重建 skills 上全部既有索引（0010 的 idx_skills_status + 0015 的 idx_skills_category）。
CREATE INDEX idx_skills_status ON skills(status);
CREATE INDEX idx_skills_category ON skills(category);

PRAGMA foreign_keys = ON;
