-- 0919 需求：技能管理（1.md 第八章）+ 任务技能绑定（10.3 随任务下发）。
-- 约定与 0002 一致：业务表带 account_id，JSON 列在 SQLite 里是 TEXT，服务层 parse/stringify。
-- skill_sources 本期不做（云端/目录源后续版本）。

CREATE TABLE skills (
  id               TEXT PRIMARY KEY,
  account_id       TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  name             TEXT NOT NULL,
  type             TEXT NOT NULL
                     CHECK (type IN ('prompt','steps','flow','script','knowledge','composite','workflow')),
  status           TEXT NOT NULL DEFAULT 'DRAFT'
                     CHECK (status IN ('DRAFT','PUBLISHED','ARCHIVED')),
  description      TEXT NOT NULL DEFAULT '',
  tags             TEXT NOT NULL DEFAULT '[]',
  current_version  TEXT NOT NULL DEFAULT 'v0.1.0',
  content          TEXT NOT NULL DEFAULT '{"blocks":[],"entryBlockId":null}',
  mcp_dependencies TEXT NOT NULL DEFAULT '[]',
  created_at       TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at       TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX idx_skills_account ON skills(account_id, status);
-- 同账号内技能名唯一（导入重名由服务层加后缀，不靠约束）
CREATE UNIQUE INDEX uniq_skills_account_name ON skills(account_id, name);

CREATE TABLE skill_versions (
  id               TEXT PRIMARY KEY,
  skill_id         TEXT NOT NULL REFERENCES skills(id) ON DELETE CASCADE,
  version          TEXT NOT NULL,
  content          TEXT NOT NULL DEFAULT '{"blocks":[],"entryBlockId":null}',
  mcp_dependencies TEXT NOT NULL DEFAULT '[]',
  changelog        TEXT NOT NULL DEFAULT '',
  created_at       TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (skill_id, version)
);

CREATE INDEX idx_skill_versions_skill ON skill_versions(skill_id);

-- 任务技能绑定：JSON 数组 [{skill_id, version?}]，无需关联表（本期口径）。
ALTER TABLE tasks ADD COLUMN skills TEXT NOT NULL DEFAULT '[]';
