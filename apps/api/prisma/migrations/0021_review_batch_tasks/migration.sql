-- 自动审核器·审核批次任务数据层棒（草案 docs/自动审核器落地草案.md §7 第 1~4 条，A1 片）：
-- 1) task_dependencies 整表重建：type 的 CHECK 从 ('blocks','relates') 扩为
--    ('blocks','relates','review')（§3.2）。`review` 是「批次 → 被审对象」的**纯标记边**，
--    不参与认领过滤、不参与环检测（与 relates 同级的处置，实证见草案 §2 第 1/3 行）。
-- 2) tasks 加 `review_batch INTEGER NOT NULL DEFAULT 0`（§3.1 三档身份的唯一行为判据）
--    + 两条批次分桶索引 (status, review_batch) / (archived_at, review_batch)（§4.3 复用键、§5.9 筛选）。
-- 3) reviews 加 `reviewer_run_id TEXT`（可空）+ 索引 idx_reviews_reviewer_run（§3.3 N20）。
-- 4) 把 `审核` 追加进**已生效的** task_types 设置行（§7 第 4 条的生效面，见本段注释——
--    草案只点了 contract/enums.ts:226 的代码默认值，没覆盖 0001:203 那条种子行，见文件末 4) 的论证）。
-- 其余 §7 第 4 条的代码侧默认值：contract/enums.ts 的 DEP_TYPES/DEFAULT_TASK_TYPES、
-- contract/settings.ts 的四个审核键。删 MCP 两工具（§7 第 5 条）是 A4 的活，不在本棒。
--
-- 为什么 task_dependencies 必须整表重建：SQLite 的列级 CHECK 长在表定义里，
-- `ALTER TABLE ADD COLUMN` 只能给**新列**挂 CHECK（0015/0020 先例），既有列 type 的词表无法就地改——
-- 只能按 0017/0018 全套先例重建：新表带三值 CHECK → INSERT SELECT 全量拷贝 → DROP 旧表
-- → RENAME 顶替 → 重建本表全部既有索引。
--
-- 为什么索引一个都不能少（0014 的教训：DROP TABLE 连索引同毁）：本表既有两条显式索引
-- idx_deps_task(task_id) 与 idx_deps_depends_on(depends_on)（0001:47-48）——前者是「这支任务的前置」
-- 读路径，后者是 §3.2 反查「这支被哪支活跃批次覆盖」（`depends_on=? AND type='review'`）的唯一入口，
-- 丢了它认领载荷与批次抽屉只能全表扫。表级 `UNIQUE (task_id, depends_on)`（0001:44）在 CREATE TABLE
-- 里原位保留（它同时兜住「同一批次对同一对象天然去重」，N16 只需再管跨批次）。
--
-- 为什么 RENAME 顶替即可恢复语义：task_dependencies 是**叶子表**——全库没有任何表 REFERENCES 它
-- （只有本表自己的两个外键指向 tasks，0001:39-40），所以 DROP 期间不会有别表外键悬空；
-- RENAME 顶替 vacated 的名字后，本表两条 ON DELETE CASCADE 自动落到新表（同 0018/0020 关键注释）。
-- 外键 pragma 的处理照 bootstrap.ts：迁移执行器（src/infra/bootstrap.ts）在 BEGIN 之前已在连接上
-- `PRAGMA foreign_keys = OFF`（该 pragma 无法在事务内切换），COMMIT 后恢复；本文件的 PRAGMA 行与
-- 0010/0017/0018 一样只是自描述姿态，事务内实际是 no-op，不构成第二重保障。
--
-- 不需要洗数（1~3 段）：老行的 type 取值只可能是 blocks/relates（旧 CHECK 钉住），必然落在新三值词表里，
-- 拷贝即合规。存量 tasks 行吃 review_batch 的常量默认 0 = 「不是批次」，无需 UPDATE。
-- 不改 updated_at：加列与重建都是 schema 扩容而非用户编辑（0009/0015~0020 同口径）；
-- 第 4 段那条 settings 行的值改写同样不带 updated_at 赋值（该列只有 DEFAULT、无 ON UPDATE，原值留下）。
--
-- fresh 全量重放与增量升级终值一致：0001~0020 定稿不回改（0001 的 ('blocks','relates') CHECK 先照旧
-- 落地，本棒随后收敛），水位 0020 的既有库只重放本棒即到达同一终态。第 4 段同理：fresh 里 0001 的
-- task_types 种子行是五词原样、本棒追加成六词；增量库里那一行若仍是五词（用户没动过）同样追加为六词，
-- 用户改过则在他的原词原序之后追加一个 `审核`（N32 稳健追加：自定义词表优先、不重写，§3.1「词表可改名可删除」）。
-- 本文件与 0001~0020 一样是权威 DDL（含 CHECK），不要用 `prisma migrate dev` 重算。

-- 1) task_dependencies：type CHECK 扩 review（0018 法整表重建，列定义逐字照 0001:37-46、列序一致）。
PRAGMA foreign_keys = OFF;

CREATE TABLE task_dependencies_new (
  id          TEXT PRIMARY KEY,
  task_id     TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  depends_on  TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  -- 词表 = 0001 的 blocks/relates + 本迁移的 review（§3.2 纯标记边，方向 批次 → 被审对象），
  -- 与 src/contract/enums.ts 的 DEP_TYPES 逐项一致。
  type        TEXT NOT NULL DEFAULT 'blocks'
                CHECK (type IN ('blocks','relates','review')),
  created_at  TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (task_id, depends_on)
);

-- 显式列清单，不赌列序（0018 同法）；全量拷贝，无 CASE、无洗数。
INSERT INTO task_dependencies_new (id, task_id, depends_on, type, created_at)
SELECT id, task_id, depends_on, type, created_at
FROM task_dependencies;

DROP TABLE task_dependencies;

-- 关键：本表是叶子表（无表 REFERENCES 它），RENAME 顶替 vacated 的名字即恢复本表指向 tasks 的
-- 两条 ON DELETE CASCADE 语义（0018/0020 同法）。
ALTER TABLE task_dependencies_new RENAME TO task_dependencies;

-- 重建本表全部既有索引（0001:47-48），一条都不能少。
CREATE INDEX idx_deps_task ON task_dependencies(task_id);
CREATE INDEX idx_deps_depends_on ON task_dependencies(depends_on);

PRAGMA foreign_keys = ON;

-- 2) tasks：审核批次标记 + 两条分桶索引（§7.2 字面口径，就这三行）。
-- **不加列级 CHECK**：0/1 的取值纪律与既有 `tasks.pinned INTEGER NOT NULL DEFAULT 0`（0001:18）同法，
-- 由服务端代码保证——只有建批路径能写 1，`review_batch` 不进 update_task / REST PATCH 可写键（§3.1）。
-- 取值语义：0 = 普通任务；1 = 审核批次任务（行为判据一律用它，不用 type='审核'，因为类型词表
-- 用户可改名可删除，删掉那个词不得打断已在跑的回路）。
-- 用 ALTER 而非重建：本段只加带常量默认值的新列（0015/0020 先例），不牵动 tasks 的既有 CHECK
-- （status/priority/stop_reason 取值权威在后续迁移里，本次一条不动）与既有六条索引。
ALTER TABLE tasks ADD COLUMN review_batch INTEGER NOT NULL DEFAULT 0;
-- 认领/复用键与分流谓词的落点：§4.3 找可复用批次、§4.7 收工判定都按 status 分桶扫批次；
-- 第二条覆盖归档态（N7 复用键必须排除 archived_at IS NOT NULL，§5.9 的隐藏批次维度同形）。
CREATE INDEX idx_tasks_review_batch_status   ON tasks(status, review_batch);
CREATE INDEX idx_tasks_review_batch_archived ON tasks(archived_at, review_batch);

-- 3) reviews：批次归属一列（§3.3 N20；本轮只加这一列，预算计数零新列——C2 把轮次预算记在
--    被审对象身上，算法是 COUNT(reviews WHERE task_id=obj AND reviewer_type='agent')，不新加计数列）。
-- 语义区别（务必别挪用）：既有 `reviews.run_id`（0001:130）是「**被审**的那次 Run」——
-- 即被审对象自己的 current_run_id 那条；本列 `reviewer_run_id` 是「**给出这条结论的审核方 Run**」——
-- 即审核批次任务的那次 Run（task_runs.id，其 task_id 就是批次）。人审为 NULL。
-- 可空、无 CHECK、**不建外键**（§7.3 字面口径就是 TEXT）：松散引用与同表 run_id / 与 tasks 的
-- parent_task_id 同形，避免给审核记录加一条级联删除路径（删批次不得连带删掉它给过的结论）。
-- 将来 §5.7 批次抽屉按它 `JOIN task_runs ON task_runs.id = reviews.reviewer_run_id WHERE task_id=批次`
-- 做逐次执行汇总，§5.4 被审侧按它反查批次短号（run.task_id）。
ALTER TABLE reviews ADD COLUMN reviewer_run_id TEXT;
CREATE INDEX idx_reviews_reviewer_run ON reviews(reviewer_run_id);

-- 4) settings 的生效词表**稳健追加** `审核`（§7 第 4 条的数据面；追加而不是替换 = 2026-09-29 用户拍板 N32）。
--
-- 为什么要有这一段：`task_types` 不是「代码默认值 + 可选覆盖行」的普通键——0001:203 在建表末尾就
-- **种下了一行**（五词 JSON 文本），而 SettingsService.all() 的口径是「有行用行、无行才吃
-- DEFAULT_SETTINGS」（infra/settings.service.ts:26-37）。只改 contract/enums.ts 的 DEFAULT_TASK_TYPES 的话，
-- 那一行会永久 shadow 掉代码默认值：任何库里生效的词表都是行里那五词，`审核` 永远进不去，
-- 设置页与 get_vocabulary 的 task_types.current 从此与 .default 分叉——既有断言
-- settings-api.test.ts:47「新库读回全键默认值」与 vocabulary.test.ts:51「current 与 DEFAULT_TASK_TYPES 一致」
-- 当场红（两者都不在本片的可改清单里）。本段就做一件事：把那一行与 DEFAULT_TASK_TYPES 对齐。
--
-- 为什么是**追加**而不是整串替换：上一棒的守卫是「value 逐字等于 0001 种子串才改写」，于是用户只要
-- 动过一个词（改个名、加一个自己的类型），生效行就一辈子停在旧形状、永远拿不到 `审核`（N32 已推翻该写法）。
-- 现在用 JSON1 在数组**末尾挂一项**：用户既有的词、既有的顺序一个不动——json_insert 不排序、不去重、
-- 不触碰前面的元素。词表是用户资产（§3.1「可改名可删除」），平台只补一个词，不替用户重排他的清单。
-- 唯一可能被改动的非词内容是空白：那行若被人手写成 `["a", "b"]`，JSON1 重写成紧凑形状，词与顺序不变，
-- 产物正是 encodeSetting（JSON.stringify，contract/settings.ts:88-90）的同一份文本，decodeSetting 原样读回 string[]。
--
-- 为什么**已经含就一动不动**：NOT EXISTS 那道 json_each 判断命中即整行不写，本段因此天然幂等
-- （§10-29：二次重放不追加第二个）。存在性判据取 json_each 的**元素等值**而不是
-- `value LIKE '%"审核"%'` 的子串包含：后者会把「审核任务」这类既有词误判成「已含 `审核`」，第六词从此
-- 永远加不上（子串匹配对 JSON 里的转义与空白也不可靠）。json_each 只展开**顶层**元素，嵌套数组/对象的
-- value 是整棵子树的 JSON 文本、等不上裸词，所以 `["审核"]` 这种畸形元素不会被当成「已有这个词」。
--
-- **这一段不是回路的承重墙**（§7 约束 14 / §3.1）：A2 的服务端派生建批写 `type='审核'` 走的是绕过生效
-- 词表校验的分支，批次身份的行为判据是 `tasks.review_batch`（本迁移第 2 段），不是词表里的这个字符串。
-- 所以这一段跑到位与否都不决定自动轨成败：用户把 `审核` 从词表里删掉，挂批/领取/回写照常，掉的只是展示面
-- ——类型 Badge 按 20.2「表外值原样透传」照旧显示 `审核`、「类型」筛选下拉少一个选项、人在四个建单面选不到它
-- （那道保留词闸在 A4）。本段定位仅止于「让 fresh 库与没改过词表的增量库跟 DEFAULT_TASK_TYPES 对齐」，
-- 不要拿它当成功条件，也不要把回路成败押在它身上。
--
-- WHERE 谓词链（顺序是承重的一半：JSON1 的 json_type/json_array_length/json_each 对坏 JSON 一律抛
-- `malformed JSON`，SQLite 的 AND 从左到右短路求值，所以 json_valid 必须排在所有 JSON 函数之前——
-- 无守卫时这条 UPDATE 直接把整条 0021 回滚，升级当场失败。写法照 0015:73-74、0016:37-38 的同族守卫，
-- 该短路事实由 §10-29 的坏 JSON 行演练钉住）：
--   · `key = 'task_types'` —— 库里**没有**这一行时本段自然空转：那时 SettingsService 吃 DEFAULT_SETTINGS，
--     而 DEFAULT_TASK_TYPES 已含 `审核`，口径天然一致，不需要在这里替用户补插一行（无行 ≠ 坏行）。
--   · `json_valid(value)` —— 用户手改坏的行列原样留着、迁移不炸（§10-29）。坏 JSON 留给设置页修复：
--     平台不替用户猜词表。
--   · `json_type(value, '$') = 'array'` —— 值是合法 JSON 但**不是数组**（对象/标量）的同样不动：
--     往非数组上追加只会造出 decodeSetting 读不回来的形状。
--   · `json_array_length(value) < 20` —— 词表上限是 20（contract/settings.ts:31 的 zod `.max(20)`）。
--     第 21 个词让 decodeSetting 的 parse 整键失败、用户那二十个词一起回落成默认词表——那才是真把用户
--     词表洗掉了，与 N32「保留用户既有的词」正对面，所以满编时宁可不加（想要就在设置页自己腾一个词位；
--     不加也不影响回路，理由见上一段）。
--   · `NOT EXISTS (… json_each … = '审核')` —— 已含则整行不写（幂等）。
--
-- 不给 updated_at 赋值：与前三段同口径——本段是种子行扩容而不是用户编辑（0009/0015~0020 同法）；
-- 该列只有 DEFAULT、无 ON UPDATE，所以原值原样留着（演练用哨兵时间戳钉住这一条）。
--
-- fresh 与增量两条路径终值一致：fresh 里 0001 的五词种子行被本段追加成六词；水位 0020 的既有库里那一行
-- 若仍是那五词（用户没动过）追加成**逐字相同**的六词；用户改过则原词原序 + 末尾一个 `审核`。
UPDATE settings
SET value = json_insert(value, '$[#]', '审核')
WHERE key = 'task_types'
  AND json_valid(value)
  AND json_type(value, '$') = 'array'
  AND json_array_length(value) < 20
  AND NOT EXISTS (SELECT 1 FROM json_each(settings.value) WHERE json_each.value = '审核');
