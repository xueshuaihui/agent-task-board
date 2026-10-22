-- 客户端入口管理（切片 A）：台账表 client_entries 与自测表 wake_probes。
-- 本文件是权威 DDL（含 CHECK），不要用 `prisma migrate dev` 重算（会丢掉 CHECK）。
-- fresh 重放与增量升级（水位 0024）走到同一终值：两张表、四个索引、同名词表逐项一致。
-- `PRAGMA user_version` 由 bootstrap 在整段 SQL 成功后写入，本文件不要自带。

CREATE TABLE client_entries (
  id TEXT PRIMARY KEY,
  client TEXT NOT NULL CHECK (client IN ('qoder','cursor','cline','windsurf','claude_code','codex')),
  scope TEXT NOT NULL CHECK (scope IN ('project','user')),
  workspace_path TEXT,
  asset_type TEXT NOT NULL CHECK (asset_type IN ('rule','skill')),
  asset_name TEXT NOT NULL,
  target_path TEXT NOT NULL,
  write_mode TEXT NOT NULL CHECK (write_mode IN ('file','managed_block')),
  content_hash TEXT NOT NULL,
  file_hash TEXT NOT NULL,
  template_version INTEGER NOT NULL,
  marker TEXT NOT NULL,
  created_file INTEGER NOT NULL DEFAULT 0,
  backup_path TEXT,
  status TEXT NOT NULL DEFAULT 'installed' CHECK (status IN ('installed','drifted','missing','error')),
  last_error TEXT,
  installed_at TEXT NOT NULL,
  verified_at TEXT,
  updated_at TEXT NOT NULL,
  CHECK ((scope = 'project' AND workspace_path IS NOT NULL)
      OR (scope = 'user' AND workspace_path IS NULL))
);
CREATE UNIQUE INDEX uniq_client_entries_target
  ON client_entries(client, scope, asset_type, asset_name, target_path);
CREATE INDEX idx_client_entries_client_scope ON client_entries(client, scope);
CREATE INDEX idx_client_entries_workspace ON client_entries(workspace_path);

CREATE TABLE wake_probes (
  id TEXT PRIMARY KEY,
  source TEXT,
  token_id TEXT,
  token_name TEXT,
  received_at TEXT NOT NULL
);
CREATE INDEX idx_wake_probes_received ON wake_probes(received_at);
