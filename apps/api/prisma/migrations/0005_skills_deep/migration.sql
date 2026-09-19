-- 0919 需求：技能后端深化（1.md 8.3/8.4/8.6/8.7/8.8）。
-- 1) 测试用例版本化（8.6）：skills / skill_versions 各加 test_cases（JSON 数组
--    [{id, name, input, expected}]），发布版本时随版本快照。
-- 2) 人工块流转（8.4）：tasks.status 词表补 BLOCKED（RUNNING→BLOCKED 由 Agent 端
--    专用端点产生；BLOCKED→READY/BACKLOG 由用户流转）。
-- 约定与 0003 一致：JSON 列在 SQLite 里是 TEXT，服务层 parse/stringify。

ALTER TABLE skills ADD COLUMN test_cases TEXT NOT NULL DEFAULT '[]';
ALTER TABLE skill_versions ADD COLUMN test_cases TEXT NOT NULL DEFAULT '[]';

-- tasks.status 的 CHECK 是 0001 的列级约束，SQLite 无法 ALTER CHECK，按标准流程重建表。
-- FK 必须在重建期间关闭：否则 DROP TABLE 的隐式 DELETE 会把子表行级联清空
-- （SQLite 的 PRAGMA foreign_keys 无法在事务内切换，因此执行方必须在事务外应用本 pragma；
-- prisma migrate deploy 逐语句执行，本文件顶部的 pragma 生效；bootstrap 侧在连接上统一关闭）。
PRAGMA foreign_keys = OFF;

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
  account_id            TEXT NOT NULL DEFAULT 'acct_local',
  project_id            TEXT REFERENCES projects(id) ON DELETE SET NULL,
  parent_task_id        TEXT REFERENCES tasks(id),
  sort_order            INTEGER NOT NULL DEFAULT 0,
  skills                TEXT NOT NULL DEFAULT '[]'
);

INSERT INTO tasks_new (
  id, type, title, description, status, priority, tags, required_capabilities,
  custom_fields, pinned, due_at, archived_at, lease_id, lease_expires_at,
  lease_revoked_at, stop_reason, current_run_id, claimed_at, run_count,
  created_at, updated_at, account_id, project_id, parent_task_id, sort_order, skills
)
SELECT
  id, type, title, description, status, priority, tags, required_capabilities,
  custom_fields, pinned, due_at, archived_at, lease_id, lease_expires_at,
  lease_revoked_at, stop_reason, current_run_id, claimed_at, run_count,
  created_at, updated_at, account_id, project_id, parent_task_id, sort_order, skills
FROM tasks;

DROP TABLE tasks;

-- 关键：tasks 从未被 RENAME，子表（task_runs/comments/artifacts/reviews/task_dependencies/
-- notifications）的 REFERENCES 一直指向字面量 tasks；这里把新表改名顶替 vacated 的名字，
-- RENAME 只会改写指向 tasks_new 的引用（不存在），子表引用随即落到新表上。
ALTER TABLE tasks_new RENAME TO tasks;

-- 索引随旧表一起被 DROP，按 0001/0002 原样重建（含部分索引）。
CREATE INDEX idx_tasks_status ON tasks(status);
CREATE INDEX idx_tasks_ready ON tasks(status, pinned DESC, priority ASC, created_at ASC);
CREATE INDEX idx_tasks_archived ON tasks(archived_at);
CREATE INDEX idx_tasks_lease ON tasks(lease_expires_at) WHERE status = 'RUNNING';
CREATE INDEX idx_tasks_account ON tasks(account_id, archived_at);
CREATE INDEX idx_tasks_project ON tasks(project_id);
CREATE INDEX idx_tasks_parent ON tasks(parent_task_id);

PRAGMA foreign_keys = ON;
