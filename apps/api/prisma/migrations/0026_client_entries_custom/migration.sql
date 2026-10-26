-- 客户端入口台账 client 的 CHECK 扩出第七种「伪客户端」custom（兜底：其他客户端手动指定目录）。
--
-- custom 不是 adapter：没有固定落点，用户在 plan/install 请求里带 target_dir（绝对路径），
-- 落点由 installer 合成（rule → <target_dir>/jarvis-workbench.md；skill → jarvis-workbench/SKILL.md）。
-- scope 恒为 'project'，workspace_path 记所选目录——既有 CHECK
-- `(scope='project' AND workspace_path IS NOT NULL) OR (scope='user' AND workspace_path IS NULL)`
-- 天然满足，其余列与约束一字不改。
--
-- 为什么必须整表重建：SQLite 的列级 CHECK 长在表定义里，改词表无法就地改——
-- 按 0017/0018/0021/0022 先例重建 client_entries：新表 client_entries_new 逐列照 0025
-- （列序一致、仅 client 的 IN 列表多 'custom'）→ INSERT SELECT 全量拷贝（显式列清单，
-- 不赌列序）→ DROP 旧表 → RENAME 顶替 → 重建 0025 的三个同名索引
-- （uniq_client_entries_target / idx_client_entries_client_scope / idx_client_entries_workspace）。
-- 本表没有外键，也没有别的表 REFERENCES 它，DROP 不涉及级联面。
-- 不洗数：既有行的 client 都在旧六词表内，拷贝即合规。
--
-- fresh 全量重放与增量升级终值一致：0025 定稿不改（fresh 里它先按六词 CHECK 落地，
-- 本迁移随后收敛）；水位到 0025 的既有库只重放本棒即到达同一终态。
-- 本文件与 0001~0025 一样是权威 DDL（含 CHECK），不要用 `prisma migrate dev` 重算；
-- `PRAGMA user_version` 由 bootstrap 在整段 SQL 成功后写入，本文件不要自带。

CREATE TABLE client_entries_new (
  id TEXT PRIMARY KEY,
  client TEXT NOT NULL CHECK (client IN ('qoder','cursor','cline','windsurf','claude_code','codex','custom')),
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

INSERT INTO client_entries_new (
  id, client, scope, workspace_path, asset_type, asset_name, target_path, write_mode,
  content_hash, file_hash, template_version, marker, created_file, backup_path,
  status, last_error, installed_at, verified_at, updated_at
)
SELECT
  id, client, scope, workspace_path, asset_type, asset_name, target_path, write_mode,
  content_hash, file_hash, template_version, marker, created_file, backup_path,
  status, last_error, installed_at, verified_at, updated_at
FROM client_entries;

DROP TABLE client_entries;

ALTER TABLE client_entries_new RENAME TO client_entries;

-- 重建 0025 的全部既有索引（名字与列清单逐字一致）。
CREATE UNIQUE INDEX uniq_client_entries_target
  ON client_entries(client, scope, asset_type, asset_name, target_path);
CREATE INDEX idx_client_entries_client_scope ON client_entries(client, scope);
CREATE INDEX idx_client_entries_workspace ON client_entries(workspace_path);
