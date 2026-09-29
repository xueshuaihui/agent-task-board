-- 拆解会话对 tasks / groups 改为弱引用（用户缺陷「删除卡片任务报本地服务内部错误」的根因修复）。
--
-- 症状：看板/需求页删掉一张由「需求拆解」产出的父需求卡片 → `500 {code:'INTERNAL'}` → 界面
-- 「本地服务内部错误」；同样形状在删分组（DELETE /groups/:id，cascade 与 migrate 两种策略都中）
-- 也会复现。sidecar 日志里的原话是
-- `PrismaClientKnownRequestError: Foreign key constraint violated on the foreign key`
-- 落在 `tx.task.delete({ where: { id } })` 那一行。
--
-- 根因在 DDL 的引用动作，不在删除逻辑：0012 建 breakdown_sessions 时把 §7.6 的两列照原文写成
-- 裸 `REFERENCES`（SQLite 缺省即 NO ACTION = 约束生效但不带任何级联动作），而 datasource URL
-- 是 `foreign_keys=On`（common/paths.ts），于是这两条外键是**硬约束**：
--   * `breakdown_sessions.parent_task_id` 钉住那行需求 —— 需求行一旦被物理删（tasks.service
--     `remove()` 是物理删，4.3.1 规则 4），会话行仍指向它 → FK 违规 → Prisma 抛非 ApiException
--     → ApiExceptionFilter 兜到 500 INTERNAL。
--   * `breakdown_sessions.group_id` 同理钉住分组行。
-- 这与本仓库对「溯源指针」的既有口径是矛盾的：0013 给 task_creation_logs.task_id **刻意不建外键**，
-- 注释写明「撤销物理删任务后日志仍可读」；schema.prisma 里 BreakdownSession 也**没有**关系字段，
-- 只有两个裸列——即 Prisma 侧早已把它当松散引用，DDL 却没跟上。本迁移把 DDL 对齐到这个口径。
--
-- 为什么选 ON DELETE SET NULL 而不是 CASCADE / 不建外键：
--   * CASCADE 会把拆解会话（原始需求文本 + 全部草案 + 进度流水）跟着需求一起销毁——会话是拆解
--     历史页的账本，删任务不该删历史；
--   * 不建外键（task_creation_logs 法）能修好本缺陷，但会留下悬空 id：会话详情/历史列表读到
--     指向不存在任务的指针，界面只能显示一个打不开的短号。SET NULL 既让删除通过，又保证
--     「有值必指得到」，读面形状不变——`breakdown.service.ts` 的 SessionDto 早已声明
--     `parent_task_id: string | null`（未确认的会话本就是 NULL），NULL 是一等取值，零改动即兼容。
--
-- 为什么必须整表重建：SQLite 的列级外键动作长在表定义里，`ALTER TABLE` 改不了既有列的
-- REFERENCES 子句——只能按 0010/0017/0018/0021 全套先例重建：新表带正确的外键动作 →
-- INSERT SELECT 全量拷贝（显式列清单，不赌列序）→ DROP 旧表 → RENAME 顶替。
-- breakdown_drafts / breakdown_progress 的 `REFERENCES breakdown_sessions(id) ON DELETE CASCADE`
-- 指向的是字面量表名，DROP 发生在外键关闭期间（不做隐式级联、不丢草案/进度行），RENAME 顶替
-- vacated 的名字后引用自动落到新表，CASCADE 语义原样保留（同 0018/0021 关键注释）。
-- 本表没有显式索引（只有 PRIMARY KEY 的 autoindex），故无「索引一个都不能少」的重建段（0014 的教训
-- 在这里不触发）。
--
-- 外键 pragma 的处理照 bootstrap.ts：迁移执行器（src/infra/bootstrap.ts）在 BEGIN 之前已在连接上
-- `PRAGMA foreign_keys = OFF`（该 pragma 无法在事务内切换），COMMIT 后恢复；本文件的 PRAGMA 行与其
-- 它迁移一样只是自描述姿态，事务内实际是 no-op，不构成第二重保障。
--
-- 不洗数：既有行的 group_id / parent_task_id 要么为 NULL、要么指得到（旧 CHECK 期就是硬约束），
-- 拷贝即合规。不改 updated_at：本表无该列，且 schema 修正不是用户编辑（0009/0015~0021 同口径）。
--
-- 同轮审计（一并记下，避免下一个人重新查）：库里其余裸 REFERENCES 三类**当前不可达**，本迁移不动——
--   * `tasks.parent_task_id → tasks`：删除侧 0919 护栏「父任务还挂着子任务不允许删」先拦下（409），
--     走不到 FK；
--   * `reviews.run_id` / `comments.run_id → task_runs`：task_runs 只在删任务时被级联销毁，实测
--     （T-9101/T-9102 带 run 的审核行与评论行各一条）SQLite 先删 reviews/comments 再删 task_runs，
--     删除成功；这是引擎的 FK 处理顺序而非本方设计，若要钉死需另迁一改动作，牵动 0020/0021 刚改过的
--     reviews 表，本棒不承担。
--   * `task_runs.token_id → api_tokens`：Token 只有停用（enabled=0），全库无 `apiToken.delete` 调用。
--
-- fresh 全量重放与增量升级终值一致：0012 定稿不回改（fresh 里它先按裸 REFERENCES 落地，本迁移随后
-- 收敛）；水位到 0021 的既有库只重放本棒即到达同一终态。
-- 本文件与 0001~0021 一样是权威 DDL（含 CHECK），不要用 `prisma migrate dev` 重算。

PRAGMA foreign_keys = OFF;

-- 列定义逐字照 0012:11-27（列序一致），只改两处外键动作。
CREATE TABLE breakdown_sessions_new (
  id                 TEXT PRIMARY KEY,
  requirement_text   TEXT NOT NULL,
  -- 弱引用：分组删除后会话留下、指针归空（本迁移的意图所在）。
  group_id           TEXT REFERENCES groups(id) ON DELETE SET NULL,
  parent_title       TEXT NOT NULL,
  parent_description TEXT,
  -- 弱引用：需求删除后拆解历史留下、指针归空。
  parent_task_id     TEXT REFERENCES tasks(id) ON DELETE SET NULL,
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

INSERT INTO breakdown_sessions_new (
  id, requirement_text, group_id, parent_title, parent_description, parent_task_id,
  status, agent_name, skill_used, estimated_tasks, actual_tasks,
  created_at, finished_at, confirmed_at, cancelled_at
)
SELECT
  id, requirement_text, group_id, parent_title, parent_description, parent_task_id,
  status, agent_name, skill_used, estimated_tasks, actual_tasks,
  created_at, finished_at, confirmed_at, cancelled_at
FROM breakdown_sessions;

DROP TABLE breakdown_sessions;

ALTER TABLE breakdown_sessions_new RENAME TO breakdown_sessions;
