-- Agent 审核整链移除（2026-10-09 用户裁定「让外部 Agent 当审核方」这条设计多余，先拆干净、
-- 新的审核设计另开一轮）。本迁移只拆「Agent 当审核方」那条链的数据层，**人工审核主通道**
-- （`POST /tasks/:id/review` + `reviews` 表本体 + `reviewer_name` 署名）与「免审核直通 `none`」
-- 一字不动：
--   1) tasks：删 `review_track`（REVIEW 列内的换轨位，只有「等 Agent 审 / 已转人工」这对概念用它）
--      与 `review_batch`（0021 引入、全仓零写入路径的死列）+ 它的两条分桶索引；
--      `review_mode` 的 CHECK 词表由 ('human','auto','none') 收窄为 ('human','none')。
--   2) reviews：删 `reviewer_run_id`（0021 引入的死列）+ 索引 `idx_reviews_reviewer_run`；
--      删 `reviewer_type`（拆完恒 'user'、零信息量的死列）。`reviewer_name` 保留（人审署名位）。
--   3) task_dependencies：`type` 的 CHECK 收回 0021 之前的 ('blocks','relates')；
--      存量 `type='review'` 的纯标记边删除（判据来自用户裁定「不考虑历史审核数据」）。
--   4) notifications：`kind` 词表收回 0020 之前的六词（去掉 `review_auto_pending` /
--      `review_auto_passed`）；这两类存量通知行删除——它们是「等 Agent 审 / Agent 判通过」的提醒，
--      拆链后没有对应概念。**不许**把它们改写成 `review_pending`（那是凭空造出来的假账）。
--   5) settings：删四个零消费者的审核键（`review_auto_dispatch` / `review_batch_max_targets` /
--      `review_max_rounds` / `review_rubric_skill`）；`default_review_mode` 键保留但取值收窄，
--      生效行里落在新词表之外的值改写为 'human'；`task_types` 生效行稳健删除精确等于「审核」的元素。
--
-- fresh 重放与增量升级终值一致（全项目硬约束，见本段末）：`SettingsService.all()` 是
-- 「有行用行、无行才吃 DEFAULT_SETTINGS」（src/infra/settings.service.ts:26-37），
-- 只改代码默认值管不到库里那一行，所以词表/键的变更必须同时覆盖两条路径：
--   · fresh：0001 建 tasks/reviews 时还没有这些列 → 0020 加回 → 本迁移又拆掉，
--     `task_types` 种子行被 0021 追加成六词、被本迁移第 5 段删回五词 = 新 DEFAULT_TASK_TYPES；
--   · 增量（水位 0022 的既有库，即随 v0.0.4-beta.9 出去的形状）：只重放本棒即到达同一终态。
-- 两条路径的列定义、CHECK 词表、索引集合与 settings 生效行逐项相同。
--
-- 为什么四处都要整表重建：SQLite 改既有列的 CHECK 只能重建（0017/0018/0020/0021/0022 先例），
-- `ALTER TABLE ADD COLUMN` 只能给新列挂 CHECK；删列虽然 3.35+ 支持 `DROP COLUMN`，但本仓库口径
-- 是「迁移文件即权威 DDL、重建照 0020/0021/0022 的完整先例写」，且 `tasks.review_mode` 的词表
-- 无论如何都得靠重建收敛，同一次重建里顺带删列比「DROP COLUMN + 重建」两步更少出错面。
-- 姿势一律：新表带正确定义 → **显式列清单** INSERT SELECT 全量拷贝 → DROP 旧表 →
-- RENAME 顶替 vacated 的名字 → 重建该表全部既有索引。
-- RENAME 之所以能恢复语义（0021/0022 的论证）：子表的 `REFERENCES` 写的是**字面量表名**，
-- DROP 发生在外键关闭期间（不做隐式级联、不销毁子表行），改名后引用自动落到新表上。
-- 外键 pragma 照 bootstrap.ts：迁移执行器（src/infra/bootstrap.ts）在 BEGIN 之前已在连接上
-- `PRAGMA foreign_keys = OFF`（该 pragma 无法在事务内切换），COMMIT 后恢复；本文件的 PRAGMA 行
-- 与 0010/0017/0018/0020/0021/0022 一样只是自描述姿态，事务内实际是 no-op。
--
-- 索引现状抄录（迁移前用 `select name,sql from sqlite_master where type='index'` 实测，
-- 逐条对账；`sqlite_autoindex_*` 是 PRIMARY KEY / 表级 UNIQUE 自带的，随建表语句自动重建）：
--   tasks（0022 后共八条，本棒删两条、原样恢复六条）：
--     idx_tasks_status                 ON tasks(status)                                                    保留
--     idx_tasks_ready                  ON tasks(status, pinned DESC, priority ASC, created_at ASC)        保留
--     idx_tasks_archived               ON tasks(archived_at)                                               保留
--     idx_tasks_lease                  ON tasks(lease_expires_at) WHERE status = 'RUNNING'（部分索引）    保留
--     idx_tasks_group                  ON tasks(group_id)                                                  保留
--     idx_tasks_parent                 ON tasks(parent_task_id)                                            保留
--     idx_tasks_review_batch_status    ON tasks(status, review_batch)                                      本棒删（随列走）
--     idx_tasks_review_batch_archived  ON tasks(archived_at, review_batch)                                 本棒删（随列走）
--   reviews（本棒删一条、原样恢复一条）：
--     idx_reviews_task                 ON reviews(task_id, created_at DESC)                                保留
--     idx_reviews_reviewer_run         ON reviews(reviewer_run_id)                                         本棒删（随列走）
--   task_dependencies（两条一条不能少，另有表级 UNIQUE (task_id, depends_on) 原位保留）：
--     idx_deps_task                    ON task_dependencies(task_id)                                       保留
--     idx_deps_depends_on              ON task_dependencies(depends_on)                                   保留
--   notifications（两条一条不能少，0001 的部分索引 + 0007 追加、0014/0020 重建时保下的那条）：
--     idx_notif_unread                 ON notifications(read_at) WHERE read_at IS NULL                     保留
--     idx_notif_read                   ON notifications(read_at)                                           保留
--
-- 不改 `updated_at`：删列、改 CHECK、删/改种子行都不是用户编辑（0009~0022 同口径）。
-- 本文件与 0001~0022 一样是权威 DDL（含 CHECK），不要用 `prisma migrate dev` 重算；
-- 0020/0021/0022 已随对外发布的 tag v0.0.4-beta.9 出去，绝对不回改，只在 0023 里收敛。

PRAGMA foreign_keys = OFF;

-- ============================================================================ 1) tasks
-- 列清单逐字照 0022 之后的现状（含 0002/0008/0012/0013/0020/0021 陆续追加的列，按 sqlite_master
-- 里的实际列序），只去掉 `review_track` 与 `review_batch`；`review_mode` 的 CHECK 收窄为
-- ('human','none')，其余既有 CHECK（status/priority/stop_reason/origin_type/confirmation_mode）
-- 与外键动作一条不动。
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
  claimed_at             TEXT,
  run_count             INTEGER NOT NULL DEFAULT 0,
  created_at            TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at            TEXT NOT NULL DEFAULT (datetime('now')),
  group_id              TEXT REFERENCES groups(id) ON DELETE SET NULL,
  parent_task_id        TEXT REFERENCES tasks(id),
  sort_order            INTEGER NOT NULL DEFAULT 0,
  skills                TEXT NOT NULL DEFAULT '[]',
  breakdown_session_id  TEXT,
  origin_type           TEXT DEFAULT 'user'
                          CHECK (origin_type IN ('user','agent')),
  origin_agent          TEXT,
  origin_skill          TEXT,
  origin_session_id     TEXT,
  confirmation_mode     TEXT
                          CHECK (confirmation_mode IN ('direct','light','silent')),
  -- 审核方式（0020 引入、本棒收窄）：human=结果强制人工审核（现状）/ none=免审核直通。
  -- 与 src/contract/enums.ts 的 REVIEW_MODES 逐项一致。
  review_mode           TEXT NOT NULL DEFAULT 'human'
                          CHECK (review_mode IN ('human','none'))
);

-- 存量 `review_mode='auto'` 的归处（判据，用户 2026-10-09 裁定第 2 条「审核相关列的存量取值可以弃」
-- 与本棒「人工审核主通道行为一字不许变」的交集）：**归 human**，即回到「结果强制人工审核」现状——
-- 这些任务本来就是「跑完等审核」，只是等的是 Agent；拆掉 Agent 后剩下的唯一合法等待对象是人，
-- 于是既不变宽松（归 none 等于替用户批量免审、把未审过的结果直接放成已完成），也不新增状态。
-- 同一判据顺带兜住手改库留下的表外值（既不是 human 也不是 none 的一律按保守的 human 落）。
-- 除此之外全量拷贝，不洗别的列：tasks 的业务数据（标题/状态/租约/来源/分组/父子）零丢失。
INSERT INTO tasks_new (
  id, type, title, description, status, priority, tags, required_capabilities, custom_fields,
  pinned, due_at, archived_at, lease_id, lease_expires_at, lease_revoked_at, stop_reason,
  current_run_id, claimed_at, run_count, created_at, updated_at, group_id, parent_task_id,
  sort_order, skills, breakdown_session_id, origin_type, origin_agent, origin_skill,
  origin_session_id, confirmation_mode, review_mode
)
SELECT
  id, type, title, description, status, priority, tags, required_capabilities, custom_fields,
  pinned, due_at, archived_at, lease_id, lease_expires_at, lease_revoked_at, stop_reason,
  current_run_id, claimed_at, run_count, created_at, updated_at, group_id, parent_task_id,
  sort_order, skills, breakdown_session_id, origin_type, origin_agent, origin_skill,
  origin_session_id, confirmation_mode,
  CASE
    WHEN review_mode = 'none' THEN 'none'
    WHEN review_mode = 'human' THEN 'human'
    ELSE 'human'
  END
FROM tasks;

DROP TABLE tasks;

-- 关键：全库指向 tasks 的外键（reviews/task_runs/comments/artifacts/task_dependencies/
-- notifications/breakdown_sessions）写的都是字面量 `tasks`，DROP 期间外键关闭、不级联销毁子行，
-- RENAME 顶替 vacated 的名字后引用自动落到新表（0005 重建 tasks 的同一论证）。
ALTER TABLE tasks_new RENAME TO tasks;

-- 重建 tasks 上全部既有索引（上面抄录清单的六条，一条不少；含两条部分索引/多列索引的原文形状）。
CREATE INDEX idx_tasks_status ON tasks(status);
CREATE INDEX idx_tasks_ready ON tasks(status, pinned DESC, priority ASC, created_at ASC);
CREATE INDEX idx_tasks_archived ON tasks(archived_at);
CREATE INDEX idx_tasks_lease ON tasks(lease_expires_at) WHERE status = 'RUNNING';
CREATE INDEX idx_tasks_group ON tasks(group_id);
CREATE INDEX idx_tasks_parent ON tasks(parent_task_id);

-- ============================================================================ 2) reviews
-- 列定义逐字照 0001:127-138 + 0020:36-40（追加的两列里只留 `reviewer_name`），
-- 去掉 `reviewer_type`（拆完它恒 'user'，两值词表退化成一个常量 = 零信息量的死列）与
-- `reviewer_run_id`（0021 引入、全仓零写入路径）。`conclusion` 的 CHECK 仍是 APPROVE/REJECT
-- 两值——人工审核表单从来只有这两个结论（ESCALATE 只活在 Agent 面，不落 reviews 行），本棒不动。
CREATE TABLE reviews_new (
  id           TEXT PRIMARY KEY,
  task_id      TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  run_id       TEXT REFERENCES task_runs(id),
  conclusion   TEXT NOT NULL CHECK (conclusion IN ('APPROVE','REJECT')),
  suggestion   TEXT NOT NULL,
  reason       TEXT NOT NULL,
  detail       TEXT NOT NULL,
  return_to    TEXT CHECK (return_to IN ('BACKLOG','READY')),
  priority_adj INTEGER CHECK (priority_adj BETWEEN 0 AND 3),
  created_at   TEXT NOT NULL DEFAULT (datetime('now')),
  -- 审核人署名（0020 加列）：人审侧目前为 NULL，但它是「这条结论谁给的」唯一留存位，
  -- 重新设计审核时还要用它，故保留（用户裁定：`reviewer_name` 一律保留）。
  reviewer_name TEXT
);

-- 存量行全量拷贝、不删行：`reviews` 是人工审核的结论账本（含建议/理由/细节三字段与退回目标），
-- 属「其他业务数据仍须零丢失」那一档。由 Agent 给出的那几条只丢掉 `reviewer_type` 这个来源标记
-- ——这正是裁定第 2 条允许弃的「审核相关列的存量取值」，文案与结论本身不动。
INSERT INTO reviews_new (
  id, task_id, run_id, conclusion, suggestion, reason, detail, return_to, priority_adj,
  created_at, reviewer_name
)
SELECT
  id, task_id, run_id, conclusion, suggestion, reason, detail, return_to, priority_adj,
  created_at, reviewer_name
FROM reviews;

DROP TABLE reviews;

-- reviews 是叶子表（无表 REFERENCES 它），RENAME 顶替即恢复它自己指向 tasks/task_runs 的两条外键。
ALTER TABLE reviews_new RENAME TO reviews;

CREATE INDEX idx_reviews_task ON reviews(task_id, created_at DESC);

-- ============================================================================ 3) task_dependencies
-- 列定义逐字照 0001:37-46（0021 重建时的形状），只把 `type` 的 CHECK 收回 ('blocks','relates')。
CREATE TABLE task_dependencies_new (
  id          TEXT PRIMARY KEY,
  task_id     TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  depends_on  TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  -- 词表 = 0001 的两值（0021 追加的第三种边 `review` 随本棒收回），
  -- 与 src/contract/enums.ts 的 DEP_TYPES 逐项一致。
  type        TEXT NOT NULL DEFAULT 'blocks'
                CHECK (type IN ('blocks','relates')),
  created_at  TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (task_id, depends_on)
);

-- 先删 `type='review'` 的存量边，再全量拷贝。判据来自用户 2026-10-09 裁定第 2 条
-- 「不考虑历史数据：审核相关列的存量取值可以弃，不为它做兼容或回填」：`review` 边是
-- 审核批次任务的**纯标记边**（不参与认领过滤、不参与环检测），拆链后既没有批次也没有被审概念，
-- 留着只会让反查得到一个不存在的批次 id。blocks/relates 边零丢失。
DELETE FROM task_dependencies WHERE type = 'review';

INSERT INTO task_dependencies_new (id, task_id, depends_on, type, created_at)
SELECT id, task_id, depends_on, type, created_at
FROM task_dependencies;

DROP TABLE task_dependencies;

-- 叶子表（无表 REFERENCES 它），RENAME 顶替即恢复本表两条 ON DELETE CASCADE。
ALTER TABLE task_dependencies_new RENAME TO task_dependencies;

-- 重建本表全部既有索引（0001:47-48），一条都不能少；表级 UNIQUE (task_id, depends_on) 已在
-- CREATE TABLE 里原位保留（同时兜住「同一对任务不重复挂边」）。
CREATE INDEX idx_deps_task ON task_dependencies(task_id);
CREATE INDEX idx_deps_depends_on ON task_dependencies(depends_on);

-- ============================================================================ 4) notifications
-- 列定义逐字照 0020:48-57（0001 的形状 + 0007 的列序），只把 `kind` 的词表收回 0020 之前的六词
-- （0001 五类 + 0014 的 creation_request）。
CREATE TABLE notifications_new (
  id         TEXT PRIMARY KEY,
  -- 词表 = 0001 五类 + 0014 的 creation_request；本棒去掉 0020 追加的两条自动审核 kind。
  -- 与 src/contract/enums.ts 的 NOTIFICATION_KINDS 逐项一致。
  kind       TEXT NOT NULL
               CHECK (kind IN ('review_pending','run_failed','lease_expired','review_rejected','task_unblocked','creation_request')),
  task_id    TEXT REFERENCES tasks(id) ON DELETE CASCADE,
  message    TEXT NOT NULL,
  read_at    TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- 先删这两类存量通知行：它们是「等 Agent 审」（review_auto_pending）与「Agent 判通过」
-- （review_auto_passed）的提醒，拆链后既没有对应动作也没有对应结论，留着就是点不开的铃铛。
-- **不改写成 `review_pending`**：那条的语义是「人来审」，而 review_auto_passed 对应的任务早已
-- 是 DONE——把「已经通过」写成「等待审核」是凭空造出来的假账。
-- 顺带删掉词表外的行（只可能来自手改库；不删则拷贝阶段撞新 CHECK、整条迁移回滚，
-- 升级当场失败）。通知是提醒不是业务本体，其余六类的行零丢失。
DELETE FROM notifications
WHERE kind IN ('review_auto_pending', 'review_auto_passed')
   OR kind NOT IN ('review_pending','run_failed','lease_expired','review_rejected','task_unblocked','creation_request');

INSERT INTO notifications_new (id, kind, task_id, message, read_at, created_at)
SELECT id, kind, task_id, message, read_at, created_at
FROM notifications;

DROP TABLE notifications;

-- 叶子表（无表 REFERENCES 它），RENAME 顶替即恢复它指向 tasks 的 ON DELETE CASCADE。
ALTER TABLE notifications_new RENAME TO notifications;

-- 重建 notifications 上全部既有索引（0001 的 idx_notif_unread 部分索引 + 0007 追加、
-- 0014/0020 重建时保下的 idx_notif_read），一条都不能少（0014 丢索引的教训面）。
CREATE INDEX idx_notif_unread ON notifications(read_at) WHERE read_at IS NULL;
CREATE INDEX idx_notif_read ON notifications(read_at);

PRAGMA foreign_keys = ON;

-- ============================================================================ 5) settings
-- 5-a) 四个自动审核键：全仓零读取者（0021 只落契约、没有消费者），键随链路一起拆。
-- 判据同 0007（`DELETE FROM settings WHERE key IN (...)` 清账号/市场遗留键）：删的是**生效行**，
-- 光删代码默认值没用——SettingsService「有行用行」，留着行就还有人在读一个已经不存在的开关。
-- 不给 updated_at 赋值（0009~0022 同口径：这不是用户编辑）。
DELETE FROM settings
WHERE key IN ('review_auto_dispatch', 'review_batch_max_targets', 'review_max_rounds', 'review_rubric_skill');

-- 5-b) `default_review_mode` 键保留（三条建单路共用的审核方式缺省来源，消费者
-- `src/infra/settings.service.ts:52 resolveReviewMode`），但它的词表跟着 `REVIEW_MODES` 收窄成
-- ('human','none')：生效行若还是 'auto'（或任何表外值 / 坏 JSON），不改写就会留一个非法设置值——
-- `decodeSetting` 虽然会兜底回落默认 'human'，但库里那行文本从此与设置页可选值脱节。
-- 改写落 'human'：与第 1 段 tasks 存量 auto→human 同一条判据（回到「结果强制人工审核」现状）。
-- 比较的是 JSON 文本（encodeSetting = JSON.stringify，故合法值写作 `"human"` / `"none"`）。
UPDATE settings
SET value = '"human"'
WHERE key = 'default_review_mode'
  AND (NOT json_valid(value) OR value NOT IN ('"human"', '"none"'));

-- 5-c) `task_types` 生效行**稳健删除**精确等于「审核」的元素（0021 第 4 段的反向操作）。
--
-- 为什么必须动这一行而不是只改 DEFAULT_TASK_TYPES：同 0021 第 4 段的论证——0001:203 建表末尾就
-- 种下了一行，SettingsService「有行用行」，只改代码默认值的话库里那行永远 shadow 掉它，
-- 设置页与 `get_vocabulary` 的 task_types.current 会一直带着一个已经没有对应功能的词。
--
-- 为什么是**逐元素删除**而不是整串替换回默认五词：词表是用户资产（可改名、可加自己的类型），
-- 用户可能早就把五个词改成别的。整串替换会把他的词表洗成平台默认——那才是真丢数据。
-- 这里只摘掉精确等于「审核」的那一个元素，其余词、原序、引号内的内容一律不动。
--
-- WHERE 谓词链（顺序是承重的一半，同 0021 第 4 段：JSON1 的 json_type/json_array_length/json_each
-- 对坏 JSON 一律抛 `malformed JSON`，SQLite 的 AND 从左到右短路求值，**json_valid 必须排在所有
-- JSON 函数之前**，否则一条被用户手改坏的行会让整条 0023 当场回滚）：
--   · `key = 'task_types'` —— 库里没有这一行时空转（那时 SettingsService 吃 DEFAULT_SETTINGS，
--     而新 DEFAULT_TASK_TYPES 已不含「审核」，口径天然一致；无行 ≠ 坏行，不替用户补插）。
--   · `json_valid(value)` —— 坏 JSON 原样留着、迁移不炸（留给设置页修，平台不替用户猜词表）。
--   · `json_type(value, '$') = 'array'` —— 合法 JSON 但不是数组的不动（对象/标量上没有「元素」可摘）。
--   · `NOT EXISTS (… json_each … type <> 'text')` —— 只在**全部元素都是字符串**时重写：
--     task_types 的契约是 string[]（contract/settings.ts:31），混进数字/嵌套元素的行本来就 decode
--     不回来；json_group_array 会把嵌套元素的 JSON 子树当成字符串重引，那是改形状不是摘词，不做。
--   · `EXISTS (… json_each … value = '审核')` —— 已不含就整行不写：本段因此幂等（二次重放不重写），
--     也是 fresh 路径的常态（0001 种子行是五词，0021 追加成六词，本段删回五词 = 与增量路径同终值）。
--     判据同样取 json_each 的**元素等值**而不是 `value LIKE '%"审核"%'`：后者会连「审核任务」这类
--     既有词一起误命中，把用户自己的词摘掉。
--   · `EXISTS (… json_each … value <> '审核')` —— **摘完必须还剩至少一个词**才重写：只有一个元素
--     （就是「审核」）时不动，否则得到 `[]`，而 zod 的 `.min(1)` 让空词表整键 decode 失败，
--     等于替用户把词表清空。判据取「剩余元素数」而不是 `json_array_length(value) > 1`：后者挡不住
--     `["审核","审核"]` 这种重复词形状（长度 2 但摘完仍是空）。
--
-- 重组必须 `ORDER BY j.key`（照 0015:64-70 / 0016:24-36 的先例与措辞）：SQLite 不保证聚合函数的
-- 输入行序，裸 `json_group_array`  over json_each 属于「碰巧按数组下标出来」；本段的红线是
-- 「用户原有的词与顺序一字不动」，顺序就得由显式 ORDER BY 兜，不靠运气。
UPDATE settings
SET value = (
  SELECT json_group_array(t.value)
  FROM (
    SELECT j.value AS value
    FROM json_each(settings.value) AS j
    WHERE j.type = 'text' AND j.value <> '审核'
    ORDER BY j.key
  ) AS t
)
WHERE key = 'task_types'
  AND json_valid(value)
  AND json_type(value, '$') = 'array'
  AND NOT EXISTS (SELECT 1 FROM json_each(settings.value) WHERE json_each.type <> 'text')
  AND EXISTS (SELECT 1 FROM json_each(settings.value) WHERE json_each.value = '审核')
  AND EXISTS (SELECT 1 FROM json_each(settings.value) WHERE json_each.value <> '审核');
