-- v0.0.4 W8-a3 §13.9（r3）：通知规则键新增 `creation_request`。
-- §13.9 原文：通知规则键沿用存量 settings（review_pending / review_rejected / run_failed /
-- task_archive / task_unblocked），本版新增 breakdown_*、creation_request 两组规则。
-- 本切片只接 creation_request（light 待决请求 + silent/direct 创建成功的站内通知）；
-- breakdown_* 的具名 kind 待接通知的拆解切片再扩，届时同法重建。
--
-- 0001 把 kind 的词表收在列级 CHECK 里，SQLite 不能改 CHECK——沿用 0007 对
-- notifications 的整表重建法（新表 → 拷贝 → 删旧 → 改名 → 重建两表索引：
-- 0001 的 idx_notif_unread 部分索引 + 0007 追加的 idx_notif_read，DROP TABLE 连索引同毁，缺一不可）。
-- schema.prisma 的 Notification.kind 本就是无约束 String，镜像侧仅需注释同步（词表权威在此）。

CREATE TABLE notifications_new (
  id         TEXT PRIMARY KEY,
  kind       TEXT NOT NULL
               CHECK (kind IN ('review_pending','run_failed','lease_expired','review_rejected','task_unblocked','creation_request')),
  task_id    TEXT REFERENCES tasks(id) ON DELETE CASCADE,
  message    TEXT NOT NULL,
  read_at    TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

INSERT INTO notifications_new (id, kind, task_id, message, read_at, created_at)
SELECT id, kind, task_id, message, read_at, created_at
FROM notifications;

DROP TABLE notifications;
ALTER TABLE notifications_new RENAME TO notifications;

CREATE INDEX idx_notif_unread ON notifications(read_at) WHERE read_at IS NULL;
CREATE INDEX idx_notif_read ON notifications(read_at);
