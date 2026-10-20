-- 五棒修复计划的底座：拆解重生成闭环（#4）、进度最后上报时间（#6）、需求级执行规则与领取快照（#8）
-- 三组列一次补齐，后续三棒只改业务代码、不再各迁一次。
--
-- 为什么全部用 ALTER TABLE ADD COLUMN、不重建表：本迁移加的都是**新列**——可空列或
-- `NOT NULL DEFAULT <常量>`（常量 DEFAULT 就是存量行的回填值，SQLite 给存量行落默认），
-- SQLite 直接支持；既有列的 CHECK、外键动作、索引与触发器一个都不牵动，也就不存在 0014
-- 重建丢索引的风险面（与 0020 同法）。0023 之所以整表重建，是因为它要改既有列的 CHECK
-- 词表；本迁移没有这个需求，故不写 DROP/RENAME，也不需要外键关闭姿态（bootstrap.ts 的
-- `PRAGMA foreign_keys = OFF` 只在重建类迁移里承重）。
--
-- 为什么要把 depends_on 里的旧哨兵转成显式列：纯本地架构服务端回调不了 Agent，历史“重新
-- 生成”只能把「待 Agent 重报」塞进 breakdown_drafts.depends_on 的 JSON 对象
-- `{"regeneration_pending":true}`（breakdown.service.ts 的 regenerationFlagJson /
-- hasRegenerationFlag）。这有两个硬伤：一是 depends_on 的契约是 string[]，哨兵对象会被
-- parseArray 静默降级成 []（读侧“看起来无依赖”），服务里任何要重写该列的路径都得显式判断
-- 并原样保留；二是标记与语义无关的列混居，无法索引、也无法与拆解会话的 revision 配对审计。
-- 新列 regeneration_pending 接管这个布尔态，depends_on 恢复纯数组，后续重生成流程只读写显式列。
--
-- 存量清洗的 JSON 安全：depends_on 是用户/Agent 上报的文本，可能坏 JSON、也可能不是对象
-- （数组/标量/NULL；列 DEFAULT 是 '[]'，但历史行不保证）。JSON1 的 json_type/json_extract 对
-- 坏 JSON 一律抛 malformed JSON，`AND` 链的求值顺序不能拿来兜数据修复的幂等判断，故写成
-- **嵌套 CASE**：每层先判 json_valid，再判 json_type，最后才 json_extract，保证坏行只落 0、
-- 整条迁移不回滚（0021/0023 的「json_valid 必须排在所有 JSON 函数之前」同一判据）。
-- 命中行 regeneration_note / regeneration_requested_at 保持 NULL：旧哨兵只证明“当时待重报”，
-- 没有记录理由与时刻，**不伪造**历史时间（列默认 NULL 即事实）；同理不从行上任何时间戳猜。
--
-- fresh 重放与增量升级终值一致：本文件在两条路径上是同一次执行——fresh 时 0001~0023 先建出
-- 既有形状，随后由本迁移补齐同一批列；增量库（水位 0023）只重放本棒。哨兵清洗在 fresh 路径上
-- 天然空转（建库起没有任何 breakdown_drafts 行），在增量路径上只把命中行转成显式列并把
-- depends_on 清成 '[]'；两条路径的列定义、索引与数据形状逐项相同。
--
-- 不改 updated_at / created_at：加列与哨兵转列都是 schema/数据归位而非用户编辑
-- （0009/0015~0023 同口径）。
-- 本文件与 0001~0023 一样是权威 DDL（含 CHECK），不要用 `prisma migrate dev` 重算。

-- ================================================================== 1) breakdown_sessions（#4）
-- revision：该会话的草案被“重新生成”的轮次，每次请求 +1（0=从未重生成，DEFAULT 即存量回填值）。
-- revision_note：用户本次想改什么（自由文本，可空）。
-- revision_requested_at：请求时刻（可空）。
-- 仅用户/服务端写：Agent 面的可写键清单不含这三列（与 task 的 execution_rules 同一口径）。
ALTER TABLE breakdown_sessions ADD COLUMN revision INTEGER NOT NULL DEFAULT 0;
ALTER TABLE breakdown_sessions ADD COLUMN revision_note TEXT;
ALTER TABLE breakdown_sessions ADD COLUMN revision_requested_at TEXT;

-- ================================================================== 2) breakdown_drafts（#4）
-- 与 session 上的 revision 配对：regeneration_pending=1 表示这一行草案被用户点名“重新生成”，
-- 等 Agent 重报（替代旧的 depends_on JSON 哨兵）；regeneration_note 是用户给的改写说明，
-- regeneration_requested_at 是请求时刻。只由用户侧服务端写；Agent 重报整行覆盖时清零/NULL。
ALTER TABLE breakdown_drafts ADD COLUMN regeneration_pending INTEGER NOT NULL DEFAULT 0;
ALTER TABLE breakdown_drafts ADD COLUMN regeneration_note TEXT;
ALTER TABLE breakdown_drafts ADD COLUMN regeneration_requested_at TEXT;

-- ================================================================== 3) 旧哨兵数据迁移（#4）
-- 历史行把「待 Agent 重报」存成 depends_on 的 JSON 对象：转成显式列并清空为纯数组 '[]'。
-- 只认 `$.regeneration_pending = 1`（JSON true 的整数值），false、缺键、纯数组、坏 JSON 一律不动，
-- 因此幂等：二次重放 0 行变化，fresh 路径无行可命中。regeneration_note /
-- regeneration_requested_at 保持 NULL（原因见文件头）。
UPDATE breakdown_drafts
   SET regeneration_pending = 1,
       depends_on = '[]'
 WHERE CASE
         WHEN json_valid(depends_on) = 0 THEN 0
         WHEN json_type(depends_on) <> 'object' THEN 0
         WHEN json_extract(depends_on, '$.regeneration_pending') = 1 THEN 1
         ELSE 0
       END = 1;

-- ================================================================== 4) tasks（#8）
-- 需求级执行规则：JSON 文本（SQLite 无 JSON 列型，客户端 parse/stringify，与 tags/skills 同法）。
-- **仅用户可写**：REST create/PATCH 落库；Agent 面 update_task 的可写键清单恒不含它——
-- 执行者不得改自己的执行规则（与 review_mode “执行者不得自豁免”同一口径）。
-- execution_rules_updated_at 只在用户改动规则时刷新，与 tasks.updated_at（任何编辑都动）解耦，
-- 用作快照/审计里的“规则版本”。
ALTER TABLE tasks ADD COLUMN execution_rules TEXT;
ALTER TABLE tasks ADD COLUMN execution_rules_updated_at TEXT;

-- ================================================================== 5) task_runs（#6、#8）
-- 进度最后上报时间（#6）：Agent 每次 report_progress 覆盖写（与 progress/progress_msg 同一事务），
-- 用于区分“一直没动”与“刚报过”。历史 Run 没有这一信息，留 NULL——不拿 started_at/finished_at 冒充。
ALTER TABLE task_runs ADD COLUMN progress_updated_at TEXT;
-- 领取时冻结的执行规则快照（#8）：JSON 文本，含需求 id/title、规则、规则更新时间、技能引用；
-- 运行中需求规则再改也不影响本次执行（快照即事实）。由服务端在 claim 时写，Agent 不可改。
ALTER TABLE task_runs ADD COLUMN rules_snapshot TEXT;
-- 规则 + 技能引用的 SHA-256（#8）：服务端 claim 时计算，供审计/回归比对。不建 CHECK——
-- 十六进制串的形状由代码保证，DDL 不把算法冻死在库里。
ALTER TABLE task_runs ADD COLUMN rules_digest TEXT;

-- ================================================================== 6) 补索引
-- 0012 建 breakdown_sessions 时漏了 parent_task_id 的索引（0022 重建也未补）：需求详情页按父任务
-- 反查拆解会话、历史页按需求过滤都走这一列。IF NOT EXISTS 兜住“手改库已自建同名索引”的形状。
CREATE INDEX IF NOT EXISTS idx_breakdown_sessions_parent ON breakdown_sessions(parent_task_id);
