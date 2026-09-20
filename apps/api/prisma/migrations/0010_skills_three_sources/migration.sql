-- v0.0.4 W2 技能体系重构（需求.md §9.1/§9.2/§21.1「技能来源枚举收敛」「skills.name 唯一约束解除」，评审修订 r2-4/r2-5）。
-- 1) `source` 旧枚举（local/market/builtin/git/http/directory 及未知值）收敛为三来源，
--    按 §21.1/§9.1 映射改写入新列 `source_type`（CHECK ('default','custom','imported')）：
--      builtin → default（应用预置只读）
--      local   → custom （用户创建）
--      market/git/http/directory 及未知值 → imported（三方技能；r2：不保留「导入来源」记录）
--    未知/异常值统一并入 imported，不静默丢数据（行本身与内容全部保留）。
-- 2) `skills.name` 唯一约束解除（uniq_skills_name DROP 不重建）：r2 唯一性由 `id`（主键，
--    终身不变、随导出/导入持久）保证，允许重名共存。列改名牵动 CHECK 与索引，按 0005/0007/0008
--    先例整表重建 skills（skill_versions 的 REFERENCES 指向字面量 skills，RENAME 顶替后自动落到新表）。
-- 3) 默认技能版本口径（§9.6/§21.1）：映射为 default 的行 current_version 固定改写为 'builtin'；
--    其余存量版本原样保留（视作重新起算的首个版本）。
-- 存量数据不改写部分：id 一律不变（任务 skills JSON 引用、skill_versions 外键因此不失效）；
-- 重名技能在旧约束下本就不存在，无需去重（0007 已做过跨账号重名去重）。
-- 本文件与 0001~0009 一样是权威 DDL（含 CHECK），不要用 `prisma migrate dev` 重算。

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
  updated_at       TEXT NOT NULL DEFAULT (datetime('now'))
);

INSERT INTO skills_new (
  id, name, type, status, description, tags, current_version, content,
  mcp_dependencies, test_cases, source_type, created_at, updated_at
)
SELECT
  id,
  name,
  type,
  status,
  description,
  tags,
  CASE WHEN source = 'builtin' THEN 'builtin' ELSE current_version END,
  content,
  mcp_dependencies,
  test_cases,
  CASE
    WHEN source = 'builtin' THEN 'default'
    WHEN source = 'local'   THEN 'custom'
    ELSE 'imported'
  END,
  created_at,
  updated_at
FROM skills;

DROP TABLE skills;

-- 关键：skill_versions 的 REFERENCES 一直指向字面量 skills；DROP 发生在外键关闭期间
-- （不做隐式 DELETE 级联），RENAME 顶替 vacated 的名字后引用自动落到新表（同 0005/0008 先例）。
ALTER TABLE skills_new RENAME TO skills;

CREATE INDEX idx_skills_status ON skills(status);
-- uniq_skills_name 随旧表 DROP 消失，刻意不重建：允许重名，唯一性收敛到 id（主键）。

PRAGMA foreign_keys = ON;
