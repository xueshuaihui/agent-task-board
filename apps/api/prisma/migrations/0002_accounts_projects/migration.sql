-- 0919 需求：账号体系（单库 accountId 隔离）、项目、任务父子（需求=任务的一种）。
-- 约定：内置账号 id 固定 'acct_local'，ATB_UI_TOKEN 兼容路径与其存量数据都归它。
-- 业务表一律 account_id NOT NULL DEFAULT 'acct_local'：旧库升级后数据自动落在内置账号，
-- 新写入由服务层按请求凭证注入，不允许依赖该默认值。

CREATE TABLE accounts (
  id                   TEXT PRIMARY KEY,
  username             TEXT NOT NULL UNIQUE,
  password_hash        TEXT NOT NULL DEFAULT '',
  salt                 TEXT NOT NULL DEFAULT '',
  algo                 TEXT NOT NULL DEFAULT 'scrypt',
  role                 TEXT NOT NULL DEFAULT 'MEMBER'
                         CHECK (role IN ('ADMIN','MEMBER')),
  status               TEXT NOT NULL DEFAULT 'ACTIVE'
                         CHECK (status IN ('ACTIVE','DISABLED')),
  must_change_password INTEGER NOT NULL DEFAULT 0,
  display_name         TEXT,
  created_at           TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at           TEXT NOT NULL DEFAULT (datetime('now'))
);

-- 内置账号：仅供 ATB_UI_TOKEN 兼容路径使用，password_hash 为空串永远过不了密码登录。
INSERT INTO accounts (id, username, role, status) VALUES ('acct_local', '__local__', 'ADMIN', 'ACTIVE');

CREATE TABLE user_preferences (
  account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  key        TEXT NOT NULL,
  value      TEXT NOT NULL DEFAULT '{}',
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (account_id, key)
);

CREATE TABLE projects (
  id          TEXT PRIMARY KEY,
  account_id  TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  name        TEXT NOT NULL,
  color       TEXT,
  icon        TEXT,
  description TEXT,
  status      TEXT NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE','ARCHIVED')),
  sort        INTEGER NOT NULL DEFAULT 0,
  created_at  TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at  TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX idx_projects_account ON projects(account_id, status, sort);
CREATE UNIQUE INDEX uniq_projects_account_name ON projects(account_id, name);

ALTER TABLE tasks ADD COLUMN account_id TEXT NOT NULL DEFAULT 'acct_local' REFERENCES accounts(id);
ALTER TABLE tasks ADD COLUMN project_id TEXT REFERENCES projects(id) ON DELETE SET NULL;
-- 父子：父必须是「需求」，嵌套最多 2 层；父不参与 Agent 领取（服务层过滤）。
ALTER TABLE tasks ADD COLUMN parent_task_id TEXT REFERENCES tasks(id);
ALTER TABLE tasks ADD COLUMN sort_order INTEGER NOT NULL DEFAULT 0;

CREATE INDEX idx_tasks_account ON tasks(account_id, archived_at);
CREATE INDEX idx_tasks_project ON tasks(project_id);
CREATE INDEX idx_tasks_parent ON tasks(parent_task_id);

ALTER TABLE api_tokens ADD COLUMN account_id TEXT NOT NULL DEFAULT 'acct_local' REFERENCES accounts(id);
CREATE INDEX idx_tokens_account ON api_tokens(account_id);

ALTER TABLE task_templates ADD COLUMN account_id TEXT NOT NULL DEFAULT 'acct_local' REFERENCES accounts(id);
CREATE INDEX idx_templates_account ON task_templates(account_id);

ALTER TABLE custom_field_defs ADD COLUMN account_id TEXT NOT NULL DEFAULT 'acct_local' REFERENCES accounts(id);
CREATE INDEX idx_field_defs_account ON custom_field_defs(account_id);

ALTER TABLE notifications ADD COLUMN account_id TEXT NOT NULL DEFAULT 'acct_local' REFERENCES accounts(id);
CREATE INDEX idx_notif_account ON notifications(account_id, read_at);
