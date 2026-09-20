-- v0.0.4 W1b 存量处置（需求.md §21.1「Project → Group 改名」/ 评审修订记录 #4）：术语迁移。-- 1) 表 `projects` → `groups`：列与约束逐列不变，索引随之改名
--    （uniq_projects_name→uniq_groups_name、idx_projects_status→idx_groups_status）。
-- 2) `tasks.project_id` → `group_id`：外键仍指 groups(id) ON DELETE SET NULL，
--    索引 idx_tasks_project→idx_tasks_group。列改名牵动外键与索引定义，按 0005/0007 先例
--    整表重建 tasks（子表 REFERENCES 指向字面量 tasks，RENAME 顶替 vacated 的名字后自动落到新表）。
-- 3) 审计账本随术语改写：action project_change→group_change、target_type project→group
--    （审计是给用户看的操作史，留旧词就成了双口径；§21.2-5）。
-- 4) 偏好 `board.grouping` 的 JSON 值同步改名：projectIds→groupIds、分组维度 project→group，
--    否则升级后看板的「按分组泳道」与多分组筛选会静默回落到默认值。
-- 本文件不含 §21.1 的「预置默认分组（is_default）」与 §5.6 分组归档（archived_at）——
-- 前者属「默认分组」改造项、后者属 W4，随各自切片另建迁移。
-- 本文件与 0001~0007 一样是权威 DDL（含 CHECK 与部分索引），不要用 `prisma migrate dev` 重算。

PRAGMA foreign_keys = OFF;

-- ---------------------------------------------------------------- groups
-- 逐列照搬 0007 之后的 projects（含 status 的 CHECK），只换表名/索引名。

CREATE TABLE groups_new (
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

INSERT INTO groups_new (id, name, color, icon, description, status, sort, created_at, updated_at)
SELECT id, name, color, icon, description, status, sort, created_at, updated_at
FROM projects;

DROP TABLE projects;
ALTER TABLE groups_new RENAME TO groups;

CREATE UNIQUE INDEX uniq_groups_name ON groups(name);
CREATE INDEX idx_groups_status ON groups(status, sort);

-- ---------------------------------------------------------------- tasks
-- 与 0007 的 tasks_new 逐列同构，只有 project_id → group_id（含 REFERENCES groups(id)）一处差异。

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
  group_id              TEXT REFERENCES groups(id) ON DELETE SET NULL,
  parent_task_id        TEXT REFERENCES tasks(id),
  sort_order            INTEGER NOT NULL DEFAULT 0,
  skills                TEXT NOT NULL DEFAULT '[]'
);

INSERT INTO tasks_new (
  id, type, title, description, status, priority, tags, required_capabilities,
  custom_fields, pinned, due_at, archived_at, lease_id, lease_expires_at,
  lease_revoked_at, stop_reason, current_run_id, claimed_at, run_count,
  created_at, updated_at, group_id, parent_task_id, sort_order, skills
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
CREATE INDEX idx_tasks_group ON tasks(group_id);
CREATE INDEX idx_tasks_parent ON tasks(parent_task_id);

-- ---------------------------------------------------------------- 审计账本改名

UPDATE audit_logs SET action = 'group_change' WHERE action = 'project_change';
UPDATE audit_logs SET target_type = 'group' WHERE target_type = 'project';

-- ---------------------------------------------------------------- 偏好值改名
-- value 是 JSON 文本（SQLite 无 JSON 列型），键名与枚举值是固定字面量，用 replace 定点改写；
-- 命中不到的行（从未存过该偏好）自然是空更新。

UPDATE user_preferences
SET value = replace(
      replace(
        replace(
          replace(
            replace(value, '"projectIds"', '"groupIds"'),
            '"primary":"project"', '"primary":"group"'
          ),
          '"secondary":"project"', '"secondary":"group"'
        ),
        -- 折叠表与「筛选分组」的键都是 `${dimension}:${laneKey}`，统一换维度前缀。
        '"project:', '"group:'
      ),
      -- 「每个主维度一份泳道顺序」的对象键（JSON 里写作 `"project":`）。
      '"project":[', '"group":['
    ),
    updated_at = datetime('now')
WHERE key = 'board.grouping' AND value LIKE '%project%';

PRAGMA foreign_keys = ON;
