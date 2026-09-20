-- v0.0.4 W4 分组归档（需求.md §5.6 / §15.1「groups.archived_at」/ §19.12-72、78 / §20.1-1，
-- r3 闭环口径见 §5.6 末段）。
-- 1) groups 加 `archived_at TEXT`（可空）：归档时间戳，与 0008 落地的 `status`
--    （CHECK ('ACTIVE','ARCHIVED')）配对使用——status 是过滤谓词（idx_groups_status 已在
--    (status, sort) 上），archived_at 是给用户看的归档时间与「归档不占 50 上限」审计的凭据。
--    SQLite 允许对可空无默认列直接 ALTER ADD COLUMN，不牵动外键/CHECK/索引，
--    无需像 0007/0008/0010 那样整表重建（0009 加 is_default 同法先例）。
-- 2) 存量对账：W1 起 PATCH 已能直接把 status 写成 'ARCHIVED'（彼时只挡了默认分组），
--    库里可能已有归档行；统一回填 archived_at = updated_at（以行的最后改动时间近似归档
--    时间，命不中就保持 NULL——语义仍是「未记录」，不造数）。
-- 本文件与 0001~0010 一样是权威 DDL，不要用 `prisma migrate dev` 重算。

ALTER TABLE groups ADD COLUMN archived_at TEXT;

UPDATE groups
SET archived_at = updated_at
WHERE status = 'ARCHIVED' AND archived_at IS NULL;
