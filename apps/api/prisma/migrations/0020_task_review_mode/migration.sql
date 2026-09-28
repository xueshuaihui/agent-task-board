-- 任务审核方式可配置·数据层棒（草案 docs/任务审核方式可配置需求草案.md §3.1/§3.2/§3.4，
-- 2026-09-28 四项拍板后定稿）：
-- - tasks 加 `review_mode`（human=人工审核（默认，Q1：默认仍人工、选 auto/none 才算显式豁免）/
--   auto=进待自动审核队列 / none=免审核直通）与 `review_track`（REVIEW 列内的换轨位：
--   auto=等审核器 / human=人工待审，Q3 兜底的落点；不引入新状态、七列矩阵不动）。
-- - reviews 加审核人两列 `reviewer_type`（user/agent）+ `reviewer_name`（可空）——
--   「这条结论是谁给的」必须看得出来（§3.2）；存量行全部由人审出，回填 user。
-- - notifications 的 kind 词表追加 `review_auto_pending`（auto 分流：等待自动审核）与
--   `review_auto_passed`（审核器判通过转 DONE；触发点在第二片 A2，契约定稿，避免 A2 再改词表）。
--
-- 为什么用 ALTER 加列而不是 0018 的整表重建：本仓库先例分两种——改**既有列的 CHECK 词表**
-- 只能重建（0017→0018），加**带 CHECK 的新列**则 SQLite 允许 `ALTER TABLE ADD COLUMN` 直接挂
-- 「常量默认值 + 列级 CHECK」（0015 先例；默认值本身在词表内，存量行按默认值即合规）。
-- 本迁移全部是后者：tasks/reviews 的既有 CHECK 一个不动，tasks 上的索引与
-- reviews→tasks 的外键都不牵动，不存在 0014 重建丢索引的风险面。
-- notifications 反过来**必须整表重建**（照 0014 法）：kind 的词表收在 0001 的列级 CHECK 里，
-- SQLite 不能就地改 CHECK；DROP/RENAME 期间新表带上全部既有索引（0001 的 idx_notif_unread
-- 部分索引 + 0007 追加、0014 重建时保下的 idx_notif_read，DROP TABLE 连索引同毁，缺一不可）。
--
-- 存量回填：三条 ADD COLUMN 的常量 DEFAULT 就是回填值（SQLite 给存量行落默认值）——
-- review_mode/review_track='human'（存量任务维持「结果强制人工审核」现状）、
-- reviewer_type='user'（§3.2 拍板的存量口径）；无需 UPDATE 洗数。
-- 不改 updated_at：加列是 schema 扩容而非用户编辑（0009/0015/0016/0017/0018/0019 同口径）。
--
-- fresh 重放与增量升级收敛：本文件在两条路径上是同一次执行（0001~0019 定稿不回改，
-- 新列一律由本迁移的同一批 ALTER/重建落地），终值天然一致；列定义与
-- src/contract/enums.ts 的 REVIEW_MODES/REVIEW_TRACKS/NOTIFICATION_KINDS 逐项一致。
-- 本文件与 0001~0019 一样是权威 DDL（含 CHECK），不要用 `prisma migrate dev` 重算。

-- 1) tasks：审核方式 + 换轨位（0015 同法的 ALTER + 表内 CHECK，DEFAULT 值落在词表内）。
ALTER TABLE tasks ADD COLUMN review_mode TEXT NOT NULL DEFAULT 'human'
  CHECK (review_mode IN ('human','auto','none'));
ALTER TABLE tasks ADD COLUMN review_track TEXT NOT NULL DEFAULT 'human'
  CHECK (review_track IN ('auto','human'));

-- 2) reviews：审核人两列。reviewer_name 可空且无词表（user 侧显示名与 agent 侧 Token 名
--    两种来源共用一列，镜像 comments.author_name 的形状），不加 CHECK。
ALTER TABLE reviews ADD COLUMN reviewer_type TEXT NOT NULL DEFAULT 'user'
  CHECK (reviewer_type IN ('user','agent'));
ALTER TABLE reviews ADD COLUMN reviewer_name TEXT;

-- 3) notifications：kind CHECK 追加 review_auto_pending / review_auto_passed，整表重建（0014 法）。
-- 外键 pragma 的处理照 bootstrap.ts：迁移执行器在 BEGIN 之前已在连接上
-- `PRAGMA foreign_keys = OFF`（该 pragma 无法在事务内切换），COMMIT 后恢复；
-- 下面两行 PRAGMA 与 0018 一样只是自描述姿态，事务内实际是 no-op。
PRAGMA foreign_keys = OFF;

CREATE TABLE notifications_new (
  id         TEXT PRIMARY KEY,
  -- 词表 = 0001 五类 + 0014 的 creation_request + 本迁移两条自动审核链路 kind。
  kind       TEXT NOT NULL
               CHECK (kind IN ('review_pending','run_failed','lease_expired','review_rejected','task_unblocked','creation_request','review_auto_pending','review_auto_passed')),
  task_id    TEXT REFERENCES tasks(id) ON DELETE CASCADE,
  message    TEXT NOT NULL,
  read_at    TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

INSERT INTO notifications_new (id, kind, task_id, message, read_at, created_at)
SELECT id, kind, task_id, message, read_at, created_at
FROM notifications;

DROP TABLE notifications;

-- 关键：notifications.task_id 的 REFERENCES 指向字面量 tasks；notifications 是叶子表，
-- 没有别的表引用它，RENAME 顶替 vacated 的名字即恢复全部语义（0007/0014 同法）。
ALTER TABLE notifications_new RENAME TO notifications;

-- 重建 notifications 上全部既有索引（0001 的 idx_notif_unread 部分索引 + 0007 的 idx_notif_read，
-- 与 0014 重建时保下的两条一字不差）。
CREATE INDEX idx_notif_unread ON notifications(read_at) WHERE read_at IS NULL;
CREATE INDEX idx_notif_read ON notifications(read_at);

PRAGMA foreign_keys = ON;
