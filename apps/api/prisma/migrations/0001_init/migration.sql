-- PRD v1.5 十一章 DDL，逐条照搬（含枚举 CHECK 与部分索引）。
-- 取值变更必须先改 20 章总表，再改本文件与 schema.prisma。
-- Prisma 无法表达 CHECK 与部分索引，因此本文件是手写权威定义，不要跑 `prisma migrate dev` 让它重算。

CREATE TABLE tasks (
  id                    TEXT PRIMARY KEY,
  type                  TEXT NOT NULL DEFAULT '需求',
  title                 TEXT NOT NULL,
  description           TEXT,
  status                TEXT NOT NULL DEFAULT 'BACKLOG'
                          CHECK (status IN ('BACKLOG','READY','RUNNING','REVIEW','DONE','FAILED')),
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
  updated_at            TEXT NOT NULL DEFAULT (datetime('now'))
);
-- 注：SQLite 的列级 CHECK 允许 NULL 通过（stop_reason 未停用时即为 NULL），这是预期语义。

CREATE INDEX idx_tasks_status ON tasks(status);
CREATE INDEX idx_tasks_ready ON tasks(status, pinned DESC, priority ASC, created_at ASC);
CREATE INDEX idx_tasks_archived ON tasks(archived_at);
CREATE INDEX idx_tasks_lease ON tasks(lease_expires_at) WHERE status = 'RUNNING';

CREATE TABLE task_dependencies (
  id          TEXT PRIMARY KEY,
  task_id     TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  depends_on  TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  type        TEXT NOT NULL DEFAULT 'blocks'
                CHECK (type IN ('blocks','relates')),
  created_at  TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (task_id, depends_on)
);

CREATE INDEX idx_deps_task ON task_dependencies(task_id);
CREATE INDEX idx_deps_depends_on ON task_dependencies(depends_on);

CREATE TABLE task_templates (
  id           TEXT PRIMARY KEY,
  name         TEXT NOT NULL,
  description  TEXT,
  preset       TEXT NOT NULL,
  sort_order   INTEGER DEFAULT 0,
  created_at   TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE custom_field_defs (
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

CREATE TABLE api_tokens (
  id           TEXT PRIMARY KEY,
  name         TEXT NOT NULL,
  token_hash   TEXT NOT NULL,
  capabilities TEXT DEFAULT '[]',
  enabled      INTEGER NOT NULL DEFAULT 1,
  last_used_at TEXT,
  created_at   TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE task_runs (
  id             TEXT PRIMARY KEY,
  task_id        TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  agent_name     TEXT,
  token_id       TEXT REFERENCES api_tokens(id),
  run_number     INTEGER NOT NULL,
  status         TEXT NOT NULL DEFAULT 'RUNNING'
                   CHECK (status IN ('RUNNING','SUCCESS','FAILED','ABANDONED')),
  trigger_type   TEXT NOT NULL DEFAULT 'agent_poll'
                   CHECK (trigger_type IN ('agent_poll','manual_retry','auto_retry')),
  lease_id       TEXT,
  started_at     TEXT NOT NULL DEFAULT (datetime('now')),
  finished_at    TEXT,
  duration_ms    INTEGER,
  output         TEXT,
  summary        TEXT,
  error          TEXT,
  progress       INTEGER CHECK (progress BETWEEN 0 AND 100),
  progress_msg   TEXT,
  UNIQUE (task_id, run_number)
);

CREATE INDEX idx_runs_task ON task_runs(task_id);
-- 认领并发兜底（9.3、4.4）：同一任务至多一条进行中的 Run
CREATE UNIQUE INDEX uniq_active_run ON task_runs (task_id) WHERE status = 'RUNNING';

CREATE TABLE artifacts (
  id          TEXT PRIMARY KEY,
  run_id      TEXT NOT NULL REFERENCES task_runs(id) ON DELETE CASCADE,
  task_id     TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  type        TEXT NOT NULL
                CHECK (type IN ('diff','image','text','log','markdown','json','html','pdf','link','file')),
  uri         TEXT NOT NULL,
  size_bytes  INTEGER,
  mime_type   TEXT,
  metadata    TEXT DEFAULT '{}',
  created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX idx_artifacts_run ON artifacts(run_id);

CREATE TABLE reviews (
  id           TEXT PRIMARY KEY,
  task_id      TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  run_id       TEXT REFERENCES task_runs(id),
  conclusion   TEXT NOT NULL CHECK (conclusion IN ('APPROVE','REJECT')),
  suggestion   TEXT NOT NULL,
  reason       TEXT NOT NULL,
  detail       TEXT NOT NULL,
  return_to    TEXT CHECK (return_to IN ('BACKLOG','READY')),
  priority_adj INTEGER CHECK (priority_adj BETWEEN 0 AND 3),
  created_at   TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX idx_reviews_task ON reviews(task_id, created_at DESC);

CREATE TABLE comments (
  id          TEXT PRIMARY KEY,
  task_id     TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  run_id      TEXT REFERENCES task_runs(id),
  author_type TEXT NOT NULL CHECK (author_type IN ('user','agent','system')),
  author_name TEXT,
  type        TEXT NOT NULL DEFAULT 'comment'
                CHECK (type IN ('comment','log','status_change')),
  content     TEXT NOT NULL,
  created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE settings (
  key        TEXT PRIMARY KEY,
  value      TEXT NOT NULL,
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE audit_logs (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  actor_type  TEXT NOT NULL CHECK (actor_type IN ('user','agent','system')),
  actor_name  TEXT,
  action      TEXT NOT NULL,
  target_type TEXT NOT NULL,
  target_id   TEXT,
  before      TEXT,
  after       TEXT,
  created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE id_sequences (
  name  TEXT PRIMARY KEY,
  next  INTEGER NOT NULL DEFAULT 1000
);

CREATE TABLE notifications (
  id          TEXT PRIMARY KEY,
  kind        TEXT NOT NULL
                CHECK (kind IN ('review_pending','run_failed','lease_expired','review_rejected','task_unblocked')),
  task_id     TEXT REFERENCES tasks(id) ON DELETE CASCADE,
  message     TEXT NOT NULL,
  read_at     TEXT,
  created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX idx_notif_unread ON notifications(read_at) WHERE read_at IS NULL;

-- api_tokens.token_hash 需要按哈希查 Token（每次 Agent 请求都查），DDL 未列但缺它即全表扫
CREATE UNIQUE INDEX idx_tokens_hash ON api_tokens(token_hash);

-- 20.9 settings 默认值（value 一律 JSON 文本）
INSERT INTO settings (key, value) VALUES
  ('lease_ttl_minutes', '30'),
  ('heartbeat_interval_seconds', '300'),
  ('board_column_limit', '50'),
  ('auto_archive_days', '30'),
  ('artifact_max_mb', '20'),
  ('backup_time', '"03:00"'),
  ('backup_keep', '7'),
  ('log_retention_days', '14'),
  ('log_level', '"info"'),
  ('task_types', '["需求","缺陷","子任务","巡检","重构"]'),
  ('ui_theme', '"system"'),
  ('review_reuse_last_opinion', 'true');

-- 20.1 短号起点
INSERT INTO id_sequences (name, next) VALUES ('task', 1000), ('run', 2000);
