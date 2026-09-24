-- 技能分类两级树化（0925 拍板，映射表见 docs/0925/二级分类草案.md §2）：
-- 受控分类词表 11 → 16 叶子——「质量保障」作废退出词表，新增六个产研阶段叶子
-- （需求与规划/开发与实现/质量与安全/代码清理/运维与协作/测试自动化，双角色词：
-- 既是「编码开发」下的二级 category 值、又合法保留在 coding 内置的 tags 里）。
-- 树形状：编码开发/办公实用/研究分析为纯分组一级（不是合法取值，选它们=422）；
-- 教育学习/内容创作/方案写作/投资理财一级本身兼叶子；开发编程按 Q1 拍板保留为过渡二级。
--
-- 为什么必须整表重建：SQLite 的列级 CHECK 长在表定义里，0015 是 `ALTER TABLE ADD COLUMN`
-- 挂上去的、0017 已经重建过一次，改词表无法就地改 CHECK——按 0017 全套先例重建 skills：
-- 新表 skills_new 带 16 叶子 CHECK → INSERT SELECT 全量拷贝 → DROP 旧表 → RENAME 顶替
-- → 重建 skills 上全部索引（idx_skills_status、idx_skills_category）。
-- skill_versions 的 REFERENCES 一直指向字面量 skills：DROP 发生在外键关闭期间
-- （不做隐式 DELETE 级联、不丢版本行），RENAME 顶替 vacated 的名字后引用自动落到新表，
-- ON DELETE CASCADE 语义原样保留（同 0010/0017 关键注释）。
-- 外键 pragma 的处理照 bootstrap.ts：迁移执行器（src/infra/bootstrap.ts）在 BEGIN 之前
-- 已在连接上 `PRAGMA foreign_keys = OFF`（该 pragma 无法在事务内切换），COMMIT 后恢复；
-- 本文件的 PRAGMA 行与 0010/0017 一样只是自描述姿态，事务内实际是 no-op，不构成第二重保障。
--
-- 0015/0016/0017 定稿不回改：fresh 全量重放里它们先照旧口径落地（0015 的 12 词 CHECK、
-- 0017 的 11 词 CHECK 都含「质量保障」），本迁移随后收敛——两条路径（增量升级 / fresh
-- 重放）终值一致。内置行的分类归位（31 coding + code-review 样例 + Q3 三条千问）不在本
-- 棒，见 0019；本迁移只管词表/schema 面与旧值「质量保障」的直映射（Q4）。
--
-- 1) 直映射「质量保障」→「质量与安全」（Q4 拍板，见文件头），**用户行与内置行一起洗、
--    先于新表落位**（同 0017 洗「开学季」先于拷贝的姿势；方向不同：0017 落 ''，本迁移落
--    语义续位值）。理由：旧 11 词里只有「质量保障」被作废，其余 10 词在新树仍全是合法叶子
--    （用户行零迁移、值不变即合法）；「质量保障」在旧词表语义下只对应编码产研域（千问 93 条
--    实测 0 行用它），新树里唯一语义续位就是「编码开发/质量与安全」；用户 custom 行的 tags
--    是纯自由标签（0016 已把词表词剔净、永不含阶段词），「按 tags 推」几乎必然落空，
--    「落 ''」又惩罚性丢失用户已选分类，均不可取（草案 §6/Q4 论证）。
--    实现形状与 0017 有一处必要差异：**不能先 `UPDATE skills SET category='质量与安全'`
--    再拷贝**——「质量与安全」不在旧表（0017 定稿 11 词）的列级 CHECK 里，UPDATE 语句本身
--    就撞旧 CHECK 炸迁移（0013~0019 增量演练实测复现）；所以直映射做进 INSERT SELECT 的
--    CASE 里，语义等价：拷贝前洗、旧值一律不落新表。不洗则 INSERT SELECT 撞新 CHECK 炸迁移。
--    内置 14 条「质量保障」映射到此值只是中间落点，0019/seed upsert 会把它们改判到各自的
--    阶段叶子终值。
-- 2) 不改 updated_at：洗数是数据归位而非用户编辑（0009/0015/0016/0017 同口径）。
-- 3) 列定义逐字照 0017 重建后的形状（仅 CHECK 的 IN 列表换成 '' + 16 叶子），列序与 0017
--    一致（category 在最后），INSERT 用显式列清单不赌列序。
-- 本文件与 0001~0017 一样是权威 DDL（含 CHECK），不要用 `prisma migrate dev` 重算。

PRAGMA foreign_keys = OFF;

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
  -- 0015 加列（DEFAULT '' 不变）；CHECK 自本迁移起为 16 叶子两级词表（0925 树化），
  -- 与 src/skills/skill-categories.ts 的 SKILL_CATEGORIES 逐项一致。
  -- 纯分组一级词（编码开发/办公实用/研究分析）不在 IN 列表里——它们不是合法取值。
  category         TEXT NOT NULL DEFAULT ''
                     CHECK (category IN ('',
                       '教育学习','投资理财','方案写作','内容创作','推荐',
                       'Office办公','实用工具','数据分析','开发编程','资讯研究',
                       '需求与规划','开发与实现','质量与安全','代码清理','运维与协作','测试自动化'))
);

INSERT INTO skills_new (
  id, name, type, status, description, tags, current_version, content,
  mcp_dependencies, test_cases, source_type, created_at, updated_at, category
)
SELECT
  id, name, type, status, description, tags, current_version, content,
  mcp_dependencies, test_cases, source_type, created_at, updated_at,
  -- Q4 直映射（见文件头 1)）：旧值「质量保障」拷贝即洗为「质量与安全」，其余原值照搬
  -- （旧 11 词里除它以外全部是新树合法叶子）。
  CASE WHEN category = '质量保障' THEN '质量与安全' ELSE category END
FROM skills;

DROP TABLE skills;

-- 关键：skill_versions 的 REFERENCES 指向字面量 skills；RENAME 顶替后自动落到新表，
-- ON DELETE CASCADE 语义保住（同 0005/0010/0017 先例）。
ALTER TABLE skills_new RENAME TO skills;

-- 重建 skills 上全部既有索引（0010 的 idx_skills_status + 0015 的 idx_skills_category）。
CREATE INDEX idx_skills_status ON skills(status);
CREATE INDEX idx_skills_category ON skills(category);

PRAGMA foreign_keys = ON;
