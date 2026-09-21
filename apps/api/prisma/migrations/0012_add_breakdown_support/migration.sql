-- v0.0.4 W7 需求拆解（需求.md §7.6 数据模型 / §7.7 状态机 / §15.1 核心表「拆解会话」）。
-- 逐条照搬 §7.6 DDL；status 的 CHECK 取 §7.7 状态机全集（receiving/reviewing/creating/
-- completed/cancelled/interrupted），与 0001 对 tasks.status 的做法一致：枚举取值以列级
-- CHECK 落库。§7.6 没有的列一律不加（超时中断由读侧/定时侧判定，不加 last_progress_at）。
-- tasks 加 §15.1 的 `breakdown_session_id TEXT`：确认创建时记录任务来源会话
-- （§7.2 阶段 7「记录来源」）；SQLite 允许可空无默认列直接 ALTER ADD COLUMN
-- （0009 加 is_default、0011 加 archived_at 同法先例）。
-- 本文件与 0001~0011 一样是权威 DDL，不要用 `prisma migrate dev` 重算。

CREATE TABLE breakdown_sessions (
  id                 TEXT PRIMARY KEY,
  requirement_text   TEXT NOT NULL,
  group_id           TEXT REFERENCES groups(id),
  parent_title       TEXT NOT NULL,
  parent_description TEXT,
  parent_task_id     TEXT REFERENCES tasks(id),
  status             TEXT NOT NULL DEFAULT 'receiving'
                       CHECK (status IN ('receiving','reviewing','creating','completed','cancelled','interrupted')),
  agent_name         TEXT,
  skill_used         TEXT,
  estimated_tasks    INTEGER,
  actual_tasks       INTEGER,
  created_at         TEXT NOT NULL DEFAULT (datetime('now')),
  finished_at        TEXT,
  confirmed_at       TEXT,
  cancelled_at       TEXT
);

CREATE TABLE breakdown_drafts (
  id          TEXT PRIMARY KEY,
  session_id  TEXT NOT NULL REFERENCES breakdown_sessions(id) ON DELETE CASCADE,
  ref         TEXT NOT NULL,
  title       TEXT NOT NULL,
  description TEXT,
  priority    INTEGER DEFAULT 3,
  skill_ids   TEXT DEFAULT '[]',
  acceptance  TEXT DEFAULT '[]',
  depends_on  TEXT DEFAULT '[]',
  sort_order  INTEGER DEFAULT 0,
  UNIQUE (session_id, ref)
);

CREATE TABLE breakdown_progress (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id TEXT NOT NULL REFERENCES breakdown_sessions(id) ON DELETE CASCADE,
  step       INTEGER NOT NULL,
  total      INTEGER NOT NULL,
  message    TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

ALTER TABLE tasks ADD COLUMN breakdown_session_id TEXT;
