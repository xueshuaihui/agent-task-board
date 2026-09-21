-- v0.0.4 W8 会话直接创建任务（需求.md §8.7 闭环语义 r3 / §8.9 数据模型 / §20 全量表）。
-- 逐条照搬 §8.9 + §20 的 tasks origin 列组：
--   * tasks 加 origin_type / origin_agent / origin_skill / origin_session_id /
--     confirmation_mode（§8.9 只列了后两列，但 §20 全量表四枚 origin 列是权威形状，
--     §8.7「仅允许撤销 origin_type=agent 且未领取的任务」要求 origin_type 存在）。
--     origin_type 默认 'user'：存量任务与非 Agent 入口的创建天然是用户来源。
--     枚举词表落成列级 CHECK（与 0001 对 tasks.status、0012 对 breakdown_sessions.status
--     同法）；confirmation_mode 取 §8.2 三模式 direct/light/silent。
--   * agent_sessions：§8.9 DDL 只有 id 主键，但 §8.7 闭环语义明确「按 session_id upsert」
--     ——session_id 是 Agent 侧会话标识（§8.7 入参样例的 "session_id"），单列 UNIQUE 承载
--     upsert 坐标；id 保留为主键（内部标识，本切片以 UUIDv7 生成）。
--     task_count / last_active_at 默认值照 §8.9。
--   * task_creation_logs：§8.9 原文。source/confirmation/user_action 是审计流水的开放词表
--     （create / edit / cancel / timeout 后续 W8 切片还会扩展），刻意不加 CHECK；
--     task_id 不建外键：§8.7 允许「5 秒撤销」物理删任务后日志仍可读（与 audit_logs 同法）。
-- SQLite ADD COLUMN 对既有行填常量默认、CHECK 对 NULL 恒通过，两张新表与加列同事务安全。
-- 本文件与 0001~0012 一样是权威 DDL，不要用 `prisma migrate dev` 重算。

ALTER TABLE tasks ADD COLUMN origin_type TEXT DEFAULT 'user'
  CHECK (origin_type IN ('user','agent'));
ALTER TABLE tasks ADD COLUMN origin_agent TEXT;
ALTER TABLE tasks ADD COLUMN origin_skill TEXT;
ALTER TABLE tasks ADD COLUMN origin_session_id TEXT;
ALTER TABLE tasks ADD COLUMN confirmation_mode TEXT
  CHECK (confirmation_mode IN ('direct','light','silent'));

CREATE TABLE agent_sessions (
  id             TEXT PRIMARY KEY,
  session_id     TEXT NOT NULL UNIQUE,
  agent_name     TEXT NOT NULL,
  started_at     TEXT NOT NULL DEFAULT (datetime('now')),
  last_active_at TEXT NOT NULL DEFAULT (datetime('now')),
  task_count     INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE task_creation_logs (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  task_id       TEXT NOT NULL,
  session_id    TEXT,
  agent_name    TEXT,
  source        TEXT NOT NULL,
  confirmation  TEXT,
  user_action   TEXT,
  created_at    TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX idx_creation_logs_task ON task_creation_logs(task_id);
CREATE INDEX idx_creation_logs_session ON task_creation_logs(session_id);
