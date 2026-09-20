-- v0.0.4 W1a 存量处置（需求.md §21.1/§21.2）：彻底移除账号体系与服务端市场。
-- 1) DROP：accounts、market_listings/market_subscriptions/market_ratings/market_comments/
--    market_favorites/market_reports/market_feedbacks（市场数据整体丢弃；
--    订阅落地技能的 JSON 存档导出在升级迁移执行前由运维侧完成，见 §21.1）。
-- 2) 全表去 account_id 列：user_preferences / projects / tasks / task_templates /
--    custom_field_defs / api_tokens / notifications / skills。
--    account_id 均带对 accounts(id) 的外键，SQLite 的 DROP COLUMN 对被外键引用的列
--    直接拒绝，故按 0005 的先例整表重建（重建期间 PRAGMA foreign_keys 由执行方在
--    连接上关闭：prisma migrate deploy 逐语句执行本文件顶部 pragma；bootstrap 侧统一关）。
-- 3) 索引重建：账号前缀索引删除；uniq_projects_account_name→uniq_projects_name、
--    uniq_skills_account_name→uniq_skills_name（单列唯一保留，去唯一是 W2 的事）。
-- 4) settings 清掉账号/市场遗留键（jwt_secret 随登录移除；cloud_* 随服务端市场下线）。
-- 本文件与 0001~0006 一样是权威 DDL（含 CHECK 与部分索引），不要用 `prisma migrate dev` 重算。

PRAGMA foreign_keys = OFF;

-- ---------------------------------------------------------------- 单例表去账号维度

-- user_preferences：主键 (account_id, key) → (key)。
-- 同 key 多账号行（理论上是脏数据）取 updated_at 最新的一条。
CREATE TABLE user_preferences_new (
  key        TEXT PRIMARY KEY,
  value      TEXT NOT NULL DEFAULT '{}',
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

INSERT INTO user_preferences_new (key, value, updated_at)
SELECT key, value, updated_at FROM user_preferences
GROUP BY key HAVING MAX(updated_at);

DROP TABLE user_preferences;
ALTER TABLE user_preferences_new RENAME TO user_preferences;

-- ---------------------------------------------------------------- projects
-- 去 account_id；idx_projects_account→idx_projects_status(status, sort)；
-- uniq_projects_account_name→uniq_projects_name。跨账号重名的存量先按 id 后缀去重，
-- 保证唯一索引可建（迁移不可逆，不留半途失败的空库）。

UPDATE projects SET name = name || '-' || substr(id, 1, 8)
WHERE rowid NOT IN (SELECT MIN(rowid) FROM projects GROUP BY name);

CREATE TABLE projects_new (
  id          TEXT PRIMARY KEY,
  name        TEXT NOT NULL,
  color       TEXT,
  icon        TEXT,
  description TEXT,
  status      TEXT NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE','ARCHIVED')),
  sort        INTEGER NOT NULL DEFAULT 0,
  created_at  TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at  TEXT NOT NULL DEFAULT (datetime('now'))
);

INSERT INTO projects_new (id, name, color, icon, description, status, sort, created_at, updated_at)
SELECT id, name, color, icon, description, status, sort, created_at, updated_at
FROM projects;

DROP TABLE projects;
ALTER TABLE projects_new RENAME TO projects;

CREATE UNIQUE INDEX uniq_projects_name ON projects(name);
CREATE INDEX idx_projects_status ON projects(status, sort);

-- ---------------------------------------------------------------- tasks
-- 去 account_id；idx_tasks_account 随列删除，其余索引按 0001/0005 原样重建（含部分索引）。
-- 子表（task_runs/comments/artifacts/reviews/task_dependencies/notifications）的
-- REFERENCES 指向字面量 tasks，RENAME 顶替 vacated 的名字后自动落到新表（0005 同构）。

CREATE TABLE tasks_new (
  id                    TEXT PRIMARY KEY,
  type                  TEXT NOT NULL DEFAULT '需求',
  title                 TEXT NOT NULL,
  description           TEXT,
  status                TEXT NOT NULL DEFAULT 'BACKLOG'
                          CHECK (status IN ('BACKLOG','READY','RUNNING','BLOCKED','REVIEW','DONE','FAILED')),
  priority              INTEGER NOT NULL DEFAULT 3 CHECK (priority BETWEEN 0 AND 3),
  tags                  TEXT DEFAULT '[]',
  required_capabilities TEXT DEFAULT '[]',
  custom_fields         TEXT DEFAULT '{}',
  pinned                INTEGER NOT NULL DEFAULT 0,
  due_at                TEXT,
  archived_at           TEXT,
  lease_id              TEXT,
  lease_expires_at      TEXT,
  lease_revoked_at      TEXT,
  stop_reason           TEXT
                          CHECK (stop_reason IN ('user_stop','lease_expired','agent_reported')),
  current_run_id        TEXT,
  claimed_at            TEXT,
  run_count             INTEGER NOT NULL DEFAULT 0,
  created_at            TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at            TEXT NOT NULL DEFAULT (datetime('now')),
  project_id            TEXT REFERENCES projects(id) ON DELETE SET NULL,
  parent_task_id        TEXT REFERENCES tasks(id),
  sort_order            INTEGER NOT NULL DEFAULT 0,
  skills                TEXT NOT NULL DEFAULT '[]'
);

INSERT INTO tasks_new (
  id, type, title, description, status, priority, tags, required_capabilities,
  custom_fields, pinned, due_at, archived_at, lease_id, lease_expires_at,
  lease_revoked_at, stop_reason, current_run_id, claimed_at, run_count,
  created_at, updated_at, project_id, parent_task_id, sort_order, skills
)
SELECT
  id, type, title, description, status, priority, tags, required_capabilities,
  custom_fields, pinned, due_at, archived_at, lease_id, lease_expires_at,
  lease_revoked_at, stop_reason, current_run_id, claimed_at, run_count,
  created_at, updated_at, project_id, parent_task_id, sort_order, skills
FROM tasks;

DROP TABLE tasks;
ALTER TABLE tasks_new RENAME TO tasks;

CREATE INDEX idx_tasks_status ON tasks(status);
CREATE INDEX idx_tasks_ready ON tasks(status, pinned DESC, priority ASC, created_at ASC);
CREATE INDEX idx_tasks_archived ON tasks(archived_at);
CREATE INDEX idx_tasks_lease ON tasks(lease_expires_at) WHERE status = 'RUNNING';
CREATE INDEX idx_tasks_project ON tasks(project_id);
CREATE INDEX idx_tasks_parent ON tasks(parent_task_id);

-- ---------------------------------------------------------------- task_templates

CREATE TABLE task_templates_new (
  id           TEXT PRIMARY KEY,
  name         TEXT NOT NULL,
  description  TEXT,
  preset       TEXT NOT NULL,
  sort_order   INTEGER DEFAULT 0,
  created_at   TEXT NOT NULL DEFAULT (datetime('now'))
);

INSERT INTO task_templates_new (id, name, description, preset, sort_order, created_at)
SELECT id, name, description, preset, sort_order, created_at
FROM task_templates;

DROP TABLE task_templates;
ALTER TABLE task_templates_new RENAME TO task_templates;

-- ---------------------------------------------------------------- custom_field_defs
-- key 全局唯一本来就不带账号维度；仅去 account_id 列与 idx_field_defs_account。

CREATE TABLE custom_field_defs_new (
  id            TEXT PRIMARY KEY,
  key           TEXT NOT NULL UNIQUE,
  label         TEXT NOT NULL,
  type          TEXT NOT NULL
                  CHECK (type IN ('text','textarea','number','select','multiselect','date','bool','url')),
  required      INTEGER NOT NULL DEFAULT 0,
  default_value TEXT,
  options       TEXT,
  applies_to    TEXT DEFAULT '[]',
  show_on_card  INTEGER NOT NULL DEFAULT 0,
  sort_order    INTEGER DEFAULT 0,
  enabled       INTEGER NOT NULL DEFAULT 1,
  created_at    TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at    TEXT NOT NULL DEFAULT (datetime('now'))
);

INSERT INTO custom_field_defs_new (
  id, key, label, type, required, default_value, options, applies_to,
  show_on_card, sort_order, enabled, created_at, updated_at
)
SELECT
  id, key, label, type, required, default_value, options, applies_to,
  show_on_card, sort_order, enabled, created_at, updated_at
FROM custom_field_defs;

DROP TABLE custom_field_defs;
ALTER TABLE custom_field_defs_new RENAME TO custom_field_defs;

-- ---------------------------------------------------------------- api_tokens
-- 表与鉴权链路保留（Agent Bearer Token），仅去账号绑定与 idx_tokens_account。

CREATE TABLE api_tokens_new (
  id           TEXT PRIMARY KEY,
  name         TEXT NOT NULL,
  token_hash   TEXT NOT NULL,
  capabilities TEXT DEFAULT '[]',
  enabled      INTEGER NOT NULL DEFAULT 1,
  last_used_at TEXT,
  created_at   TEXT NOT NULL DEFAULT (datetime('now'))
);

INSERT INTO api_tokens_new (id, name, token_hash, capabilities, enabled, last_used_at, created_at)
SELECT id, name, token_hash, capabilities, enabled, last_used_at, created_at
FROM api_tokens;

DROP TABLE api_tokens;
ALTER TABLE api_tokens_new RENAME TO api_tokens;

CREATE UNIQUE INDEX idx_tokens_hash ON api_tokens(token_hash);

-- ---------------------------------------------------------------- notifications
-- idx_notif_account(account_id, read_at) → idx_notif_read(read_at)；
-- idx_notif_unread 部分索引按 0001 原样重建。

CREATE TABLE notifications_new (
  id         TEXT PRIMARY KEY,
  kind       TEXT NOT NULL
               CHECK (kind IN ('review_pending','run_failed','lease_expired','review_rejected','task_unblocked')),
  task_id    TEXT REFERENCES tasks(id) ON DELETE CASCADE,
  message    TEXT NOT NULL,
  read_at    TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

INSERT INTO notifications_new (id, kind, task_id, message, read_at, created_at)
SELECT id, kind, task_id, message, read_at, created_at
FROM notifications;

DROP TABLE notifications;
ALTER TABLE notifications_new RENAME TO notifications;

CREATE INDEX idx_notif_unread ON notifications(read_at) WHERE read_at IS NULL;
CREATE INDEX idx_notif_read ON notifications(read_at);

-- ---------------------------------------------------------------- skills
-- 去 account_id；idx_skills_account→idx_skills_status；
-- uniq_skills_account_name→uniq_skills_name（跨账号重名存量按 id 后缀去重，同 projects）。
-- source 枚举收敛（local/market/builtin/git/http/directory → 三来源）是 W2 的事，本迁移不动值。

UPDATE skills SET name = name || '-' || substr(id, 1, 8)
WHERE rowid NOT IN (SELECT MIN(rowid) FROM skills GROUP BY name);

CREATE TABLE skills_new (
  id               TEXT PRIMARY KEY,
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
  test_cases       TEXT NOT NULL DEFAULT '[]',
  source           TEXT NOT NULL DEFAULT 'local',
  created_at       TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at       TEXT NOT NULL DEFAULT (datetime('now'))
);

INSERT INTO skills_new (
  id, name, type, status, description, tags, current_version, content,
  mcp_dependencies, test_cases, source, created_at, updated_at
)
SELECT
  id, name, type, status, description, tags, current_version, content,
  mcp_dependencies, test_cases, source, created_at, updated_at
FROM skills;

DROP TABLE skills;
ALTER TABLE skills_new RENAME TO skills;

CREATE INDEX idx_skills_status ON skills(status);
CREATE UNIQUE INDEX uniq_skills_name ON skills(name);

-- ---------------------------------------------------------------- 删表：账号与市场
-- 此刻所有对 accounts(id) 的引用（user_preferences/projects/market_*）都已随重建/删除消失。

DROP TABLE IF EXISTS market_comments;
DROP TABLE IF EXISTS market_feedbacks;
DROP TABLE IF EXISTS market_favorites;
DROP TABLE IF EXISTS market_ratings;
DROP TABLE IF EXISTS market_reports;
DROP TABLE IF EXISTS market_subscriptions;
DROP TABLE IF EXISTS market_listings;
DROP TABLE IF EXISTS accounts;

-- 账号审计随账号一并清除；市场无审计动作。
DELETE FROM audit_logs WHERE action LIKE 'account_%';

-- settings 遗留键：jwt_secret（登录移除）、cloud_*（服务端市场下线）。
DELETE FROM settings WHERE key IN ('jwt_secret', 'cloud_enabled', 'cloud_url', 'cloud_username', 'cloud_token');

PRAGMA foreign_keys = ON;
