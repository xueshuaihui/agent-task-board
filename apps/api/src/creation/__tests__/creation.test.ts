import { cpSync, mkdirSync, mkdtempSync, readdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { RequestAuth } from '../../auth/auth.scope';
import { applyMigrations, collectMigrations, migrationsDir } from '../../infra/bootstrap';
import { callAgentTool } from '../../mcp/mcp.server';
import { createAgentHarness, type AgentHarness } from '../../agent/__tests__/temp-db';
import { removeTempDirSync } from '../../__tests__/helpers/temp-dir';
import { DEFAULT_TASK_TYPES } from '../../contract/enums';
import { decodeSetting } from '../../contract/settings';
import { skillCreateSchema, DEFAULT_SKILL_VERSION } from '../../skills/skills.dto';
import { DEFAULT_SKILL_SEEDS, ensureDefaultSkills } from '../../skills/default-skills';
import type { ArtifactsService } from '../../artifacts/artifacts.service';
import { AuditService } from '../../infra/audit.service';
import type { AppLogger } from '../../infra/logger';
import { NotificationsService } from '../../infra/notifications.service';
import { TasksService } from '../../tasks/tasks.service';

/**
 * v0.0.4 W8 第一片 + W8-a2 第二片（§8.7）：board.create_task 三模式全闭环。
 * 覆盖三层：
 *  1. 迁移 0013 演练——在 /tmp 里从 0012 水位增量升级到 0013（真库禁写，一律临时目录）；
 *  2. 服务/MCP 面：直建/静默成功路径的任务 origin 列、agent_sessions upsert、
 *     task_creation_logs/audit_logs 行数断言；
 *  3. light 决策闭环（W8-a2）：确认/编辑/取消/超时+5s 宽限四路归宿、WS agent.task_requested
 *     卡片下发、board.get_creation_status / wait_for_confirmation、§8.2 模式优先级与重复升级。
 */
let h: AgentHarness;
let agent: RequestAuth;
const ui: RequestAuth = { kind: 'ui' };

const toolCtx = () => ({
  claims: h.claims,
  leases: h.leases,
  writeback: h.writeback,
  query: h.query,
  skills: h.skills,
  policy: h.policy,
  breakdown: h.breakdown,
  creation: h.creation,
  settings: h.settings,
});

function call(name: string, args: Record<string, unknown>, auth: RequestAuth = agent) {
  return callAgentTool(toolCtx(), auth, name, args);
}

async function countOf(table: string, where = '', params: unknown[] = []): Promise<number> {
  const rows = await h.prisma.$queryRawUnsafe<{ n: number }[]>(
    `SELECT COUNT(*) AS n FROM ${table} ${where}`,
    ...params,
  );
  return Number(rows[0]!.n);
}

const baseInput = {
  title: '修复登录页面的空指针异常',
  description: '登录页在 session 为空时抛 NPE',
  type: '缺陷',
  priority: 1,
  tags: ['后端'],
  session_id: 'conv-20260920-001',
  agent_name: 'qoder-1',
};

/**
 * hookTimeout 显式放宽到 30s（只这一个 hook，不动全局 testTimeout/hookTimeout）：
 * CI run 36329045226 的 win-x64 上这个 beforeAll 报 `Error: Hook timed out in 10000ms.`
 * （creation.test.ts 因此 19 tests 全 skipped、整文件红）。它做的是
 * `createAgentHarness()`（19 份迁移 DDL 落临时库）+ 第一次 Prisma 写入（原生查询引擎 DLL
 * 首次加载），mac 侧整个文件 7932ms / 19 tests 全绿、本 hook 远不到 1s，
 * Windows runner 上这两项之和却能压过 10s 的默认预算。
 */
beforeAll(async () => {
  h = createAgentHarness();
  agent = await h.agent('qoder-w8', []);
}, 30_000);

afterAll(async () => {
  await h?.dispose();
});

// ---------------------------------------------------------------- 1. 迁移演练
// 本 describe 是「迁移演练」的落点：第一条用例从水位 0012 一路增量到迁移目录的当前顶
// （0013 起每一棒，含 0021 的 ①~⑨ 与 0022 的拆解除弱引用），第二条专打 0021 第 4 段
// （fresh 全量到顶 + 水位 0020 的副本库只重放 20 之上、task_types 生效行的 A/B/C 三种行
// 与三道守卫），第三条验列语义。
/**
 * 迁移目录现取的最高编号。演练断言一律按这个顶来判，不写死某一棒的编号——
 * 写死的代价是「下一棒加迁移，本棒的红就记在他头上」（0022 拆解除弱引用时踩中两次）。
 */
const migrationTop = (): number =>
  Math.max(...collectMigrations().map((migration) => migration.order));

describe('迁移演练（/tmp 临时库，当前水位 0012/0020 → 目录顶）', () => {
  it('水位 0012 的库增量应用 0013~目录顶：只重放 12 之上的每一棒，新表与 tasks 来源列就位', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'atb-w8-mig-'));
    const previous = { data: process.env.ATB_DATA_DIR, mig: process.env.ATB_MIGRATIONS_DIR };
    try {
      process.env.ATB_DATA_DIR = dir;
      // 1) 用 0001~0012 迁移子集全量重放：造出「当前水位 0012」的既有库（真库禁写）。
      const staged = path.join(dir, 'migrations-0012');
      mkdirSync(staged);
      const source = migrationsDir();
      for (const entry of readdirSync(source)) {
        if (/^\d+_/.test(entry) && Number(entry.split('_')[0]) <= 12) {
          cpSync(path.join(source, entry), path.join(staged, entry), { recursive: true });
        }
      }
      process.env.ATB_MIGRATIONS_DIR = staged;
      const upTo12 = applyMigrations();
      expect(upTo12[upTo12.length - 1]).toBe(12);

      // 0016/0017/0018/0019 演练数据：水位停在 0012 时先造几行混灌的历史技能——
      // ① s_legacy「受众词+分类词+自由标签」：0015 回填 category=实用工具 并洗掉被取走的词，
      //    0016 再把残留词表词洗干净，终值只剩自由标签、原序不变；
      // ② s_season 只带已作废占位词「开学季」：0015（定稿 12 词表）回填会取走它、0016 从
      //    tags 洗掉，0017 的防御性洗数再把 category 落回 ''（未分类）——全量重放终值一致；
      // ③ s_qa「质量保障+自由词」：0015 取走质量保障、0016 洗 tags，0018 拷贝前把旧值
      //    直映射「质量与安全」（Q4：用户行与内置行一起洗）——终值 category=质量与安全、
      //    tags 只剩自由词；它是用户行形状（非 skl_builtin_ id），0019 不碰它；
      // ④/⑤ 两行内置 id 走 0019 回填链：skl_builtin_rc-tdd 的 tags 首词「开发编程」被 0015
      //    取走（阶段词「开发与实现」当时不在词表、留在 tags），0019 把 category 改判
      //    「开发与实现」——终值与 seed/分片一致，且 tags 里的阶段词原样活着（双角色豁免）；
      //    skl_builtin_code-review 的 tags 两词都不在词表 → 0015 落 ''，0019 回填
      //    「质量与安全」（§9.2 样例的作废旧值续位）。
      const staging = new DatabaseSync(path.join(dir, 'jarvis.db'));
      staging
        .prepare(`INSERT INTO skills (id, name, type, tags) VALUES ('s_legacy', 'legacy', 'prompt', '["官方","实用工具","推荐","我的标签"]')`)
        .run();
      staging
        .prepare(`INSERT INTO skills (id, name, type, tags) VALUES ('s_season', 'season', 'prompt', '["开学季","考研"]')`)
        .run();
      staging
        .prepare(`INSERT INTO skills (id, name, type, tags) VALUES ('s_qa', 'qa', 'prompt', '["质量保障","运营自由词"]')`)
        .run();
      staging
        .prepare(`INSERT INTO skills (id, name, type, tags) VALUES ('skl_builtin_rc-tdd', 'rc-tdd', 'prompt', '["开发编程","开发与实现"]')`)
        .run();
      staging
        .prepare(`INSERT INTO skills (id, name, type, tags) VALUES ('skl_builtin_code-review', 'code-review', 'prompt', '["review","quality"]')`)
        .run();
      // 0020 演练数据：水位 0012 时先造一条存量任务与一条存量审核结论——
      // 本迁移只 ALTER 加带常量默认值的列，这两行必须在新列上吃到「人工审核 / 人工待审 /
      // 审核人是 user」，即升级前「结果强制人工审核」的语义在存量行上原样保持。
      staging.prepare(`INSERT INTO tasks (id, title) VALUES ('t_legacy', '存量任务')`).run();
      staging
        .prepare(
          `INSERT INTO reviews (id, task_id, conclusion, suggestion, reason, detail)
           VALUES ('r_legacy', 't_legacy', 'APPROVE', 's', 'r', 'd')`,
        )
        .run();
      // 0021 演练数据：水位 0012 时先造两条既有依赖边（blocks 与显式 relates）——
      // 本迁移整表重建 task_dependencies，这两行必须零丢失、列值原样、两条 ON DELETE CASCADE
      // 与两条索引都还在（0014 丢索引的教训面）。第三值 review 在本棒之后才可写。
      staging.prepare(`INSERT INTO tasks (id, title) VALUES ('t_legacy2', '存量任务二')`).run();
      staging
        .prepare(`INSERT INTO task_dependencies (id, task_id, depends_on) VALUES ('d_blocks', 't_legacy', 't_legacy2')`)
        .run();
      staging
        .prepare(`INSERT INTO task_dependencies (id, task_id, depends_on, type) VALUES ('d_relates', 't_legacy2', 't_legacy', 'relates')`)
        .run();
      // 0021 第 4 段演练数据（A 行）：先确认 0001:203 种下的确实是那五词，再把它的 updated_at
      // 钉成哨兵值——本段只该改 value，不写 updated_at（schema 扩容不是用户编辑），⑨ 据此断言哨兵没动。
      expect(staging.prepare(`SELECT value FROM settings WHERE key = 'task_types'`).get()).toEqual({
        value: '["需求","缺陷","子任务","巡检","重构"]',
      });
      staging
        .prepare(`UPDATE settings SET updated_at = '2020-01-01 00:00:00' WHERE key = 'task_types'`)
        .run();
      staging.close();

      // 2) 切回全量迁移目录：应只增量应用 12 之上的每一棒——
      //    0013/0014（W8-a3 追加通知 kind 词表）、
      //    0015（skills.category 收口，加列不重建）、0016（tags 存量洗数，纯洗数无 DDL）、
      //    0017（词表删「开学季」12→11，重建 skills 收敛 CHECK）、
      //    0018（0925 树化 11→16 叶子，先直映射「质量保障」再重建收敛 CHECK）、
      //    0019（内置 35 行逐 id 回填叶子终值）、
      //    0020（tasks 审核方式两列、reviews 审核人两列、notifications kind 词表追加两条）
      //    与 0021（task_dependencies 整表重建把 type CHECK 扩出第三种边 review、
      //    tasks 加 review_batch 批次标记列 + 两条分桶索引、reviews 加批次归属列
      //    reviewer_run_id + idx_reviews_reviewer_run、settings 的 task_types 生效行追加「审核」；
      //    自动审核器草案 §7 第 1~4 条）
      //    与 0022（breakdown_sessions 整表重建，把 group_id / parent_task_id 两条裸
      //    REFERENCES 落成 ON DELETE SET NULL；卡片删除报 500 的修复，见该迁移头部注释）
      //    与 0023（2026-10-09 裁定「Agent 当审核方」整链移除：tasks 删 review_track/review_batch
      //    并把 review_mode 词表收窄成 human/none、reviews 删 reviewer_type/reviewer_run_id、
      //    task_dependencies 的 type 收回两值、notifications 的 kind 收回六词、
      //    settings 删四个审核键并摘掉 task_types 里的「审核」）。
      delete process.env.ATB_MIGRATIONS_DIR;
      const top = migrationTop();
      const applied = applyMigrations();
      // 0001~0012 不重放：期望值是「12 之上、按编号递增的每一棒」。
      expect(applied).toEqual(
        Array.from({ length: top - 12 }, (_, index) => index + 13),
      );

      const check = new DatabaseSync(path.join(dir, 'jarvis.db'), { readOnly: true });
      const version = check.prepare('PRAGMA user_version').get() as { user_version: number };
      expect(Number(version.user_version)).toBe(top);
      const tables = check
        .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name IN ('agent_sessions','task_creation_logs')")
        .all() as { name: string }[];
      expect(tables.map((row) => row.name).sort()).toEqual(['agent_sessions', 'task_creation_logs']);
      const taskColumns = new Set(
        (check.prepare('PRAGMA table_info(tasks)').all() as { name: string }[]).map((row) => row.name),
      );
      for (const column of ['origin_type', 'origin_agent', 'origin_skill', 'origin_session_id', 'confirmation_mode']) {
        expect(taskColumns.has(column)).toBe(true);
      }
      // 升级前已存在的任务行吃常量默认 'user'（演练库此刻还没有行，用显式插入验证默认值语义）。
      check.close();
      // 0014：notifications.kind CHECK 整表重建后放行 creation_request（§13.9 r3 新规则键），
      // 未知 kind 仍被词表挡住。演练库此时可读写，直接拿 sqlite 句柄探一次。
      const probe = new DatabaseSync(path.join(dir, 'jarvis.db'));
      probe.prepare(`INSERT INTO notifications (id, kind, message) VALUES ('n_ok', 'creation_request', 'x')`).run();
      expect(() =>
        probe.prepare(`INSERT INTO notifications (id, kind, message) VALUES ('n_bad', 'sms', 'x')`).run(),
      ).toThrow();
      // 0020 曾给 notifications.kind 追加两枚自动审核词，0023 随整链移除收回六词（清单 §14）：
      // 全量重放到顶后这两枚**不再放行**——它们是「等 Agent 审 / Agent 判通过」的提醒，
      // 拆链后没有对应概念。未知 kind 依然被挡住（上一条 n_bad 就是这条断言的反面）。
      for (const gone of ['review_auto_pending', 'review_auto_passed']) {
        expect(() =>
          probe.prepare(`INSERT INTO notifications (id, kind, message) VALUES (?, ?, 'x')`).run(`n_${gone}`, gone),
        ).toThrow();
      }
      // 0020：存量两行吃到常量默认（升级前语义 = 人工审核 + 人工待审）；
      // 0023 把 review_mode 词表收窄为 human/none，存量 'auto' 归 human（见下一条用例的专项演练）。
      const legacyTask = probe
        .prepare(`SELECT review_mode FROM tasks WHERE id = 't_legacy'`)
        .get() as { review_mode: string };
      expect(legacyTask).toEqual({ review_mode: 'human' });
      // 0023：`reviews.reviewer_type`（来源 user/agent）与 `reviewer_name` 里的前者已删、
      // 署名位保留；存量审核行本体零丢失（结论/建议/理由都还在，见列集合断言）。
      const legacyReview = probe
        .prepare(`SELECT conclusion, suggestion, reason, detail, reviewer_name FROM reviews WHERE id = 'r_legacy'`)
        .get() as { conclusion: string; suggestion: string; reason: string; detail: string; reviewer_name: string | null };
      expect(legacyReview).toEqual({
        conclusion: 'APPROVE',
        suggestion: 's',
        reason: 'r',
        detail: 'd',
        reviewer_name: null,
      });
      // 0023：被删的四列在 sqlite_master 里彻底不存在（判据③「schema 与 sqlite_master 同步归零」）。
      const columnsOf = (table: string): Set<string> =>
        new Set(
          (probe.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]).map((row) => row.name),
        );
      const reviewColumns = columnsOf('reviews');
      for (const gone of ['reviewer_type', 'reviewer_run_id']) {
        expect(reviewColumns.has(gone)).toBe(false);
      }
      expect(reviewColumns.has('reviewer_name')).toBe(true);
      const taskColumnsAfter = columnsOf('tasks');
      for (const gone of ['review_track', 'review_batch']) {
        expect(taskColumnsAfter.has(gone)).toBe(false);
      }
      expect(taskColumnsAfter.has('review_mode')).toBe(true);
      expect(() =>
        probe.prepare(`INSERT INTO tasks (id, title, review_mode) VALUES ('t_bad', 'bad', 'self')`).run(),
      ).toThrow();
      // §14 判据②：`auto` 也从词表里出去了——写它撞 CHECK，整条插入回滚。
      expect(() =>
        probe.prepare(`INSERT INTO tasks (id, title, review_mode) VALUES ('t_bad_auto', 'bad', 'auto')`).run(),
      ).toThrow();
      // 0021（自动审核器 A1 数据层）：整表重建 + 三处新列/索引。
      // ① 既有依赖行零丢失、列值原样（重建只做拷贝，不洗数——老值必然落在新词表里）；
      expect(
        probe
          .prepare(`SELECT id, task_id, depends_on, type, created_at IS NOT NULL AS has_ts FROM task_dependencies ORDER BY id`)
          .all() as { id: string; task_id: string; depends_on: string; type: string; has_ts: number }[],
      ).toEqual([
        { id: 'd_blocks', task_id: 't_legacy', depends_on: 't_legacy2', type: 'blocks', has_ts: 1 },
        { id: 'd_relates', task_id: 't_legacy2', depends_on: 't_legacy', type: 'relates', has_ts: 1 },
      ]);
      // ② 词表现在是两值：0021 追加的第三种边 `review` 已随 0023 收回（清单 §14），
      //    写它撞 CHECK；词表外值同样挡住；表级 UNIQUE(task_id, depends_on) 随重建原位保住。
      probe.prepare(`INSERT INTO tasks (id, title) VALUES ('t_legacy3', '存量任务三')`).run();
      expect(() =>
        probe.prepare(`INSERT INTO task_dependencies (id, task_id, depends_on, type) VALUES ('d_review', 't_legacy3', 't_legacy', 'review')`).run(),
      ).toThrow();
      expect(() =>
        probe.prepare(`INSERT INTO task_dependencies (id, task_id, depends_on, type) VALUES ('d_bad', 't_legacy3', 't_legacy2', 'blocks+')`).run(),
      ).toThrow();
      expect(() =>
        probe.prepare(`INSERT INTO task_dependencies (id, task_id, depends_on, type) VALUES ('d_dup', 't_legacy', 't_legacy2', 'relates')`).run(),
      ).toThrow();
      // ③ DDL 里的词表确实收回两值（重建后 sqlite_master 存的是新表定义，'review' 不再出现）；
      const depDdl = probe.prepare(`SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'task_dependencies'`).get() as { sql: string };
      expect(depDdl.sql).not.toContain(`'review'`);
      expect(depDdl.sql).toContain(`'blocks','relates'`);
      // ④ 重建保下全部既有索引，一条不少（0014 丢索引的教训面；TEXT 主键与表级 UNIQUE 自带的
      //    sqlite_autoindex_* 不算显式索引，滤掉）；
      const depIndexes = probe
        .prepare(`SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'task_dependencies'`)
        .all() as { name: string }[];
      expect(
        depIndexes.map((row) => row.name).filter((name) => !name.startsWith('sqlite_autoindex_')).sort(),
      ).toEqual(['idx_deps_depends_on', 'idx_deps_task']);
      // ⑤ 两条 ON DELETE CASCADE 语义原样恢复：删掉这一侧任务，blocks 边跟着没。
      probe.prepare(`INSERT INTO task_dependencies (id, task_id, depends_on, type) VALUES ('d_cascade', 't_legacy3', 't_legacy', 'blocks')`).run();
      probe.prepare(`DELETE FROM tasks WHERE id = 't_legacy3'`).run();
      expect(probe.prepare(`SELECT COUNT(*) AS n FROM task_dependencies WHERE id = 'd_cascade'`).get()).toEqual({ n: 0 });
      // ⑥ 0023：tasks 的两条批次分桶索引随列一起消失，其余六条原样在位（名字也要一致，
      //    验收会去 sqlite_master 里数——见清单 §14 判据③）。
      const taskIndexNames = new Set(
        (probe.prepare(`SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'tasks'`).all() as { name: string }[]).map(
          (row) => row.name,
        ),
      );
      for (const name of [
        'idx_tasks_status',
        'idx_tasks_ready',
        'idx_tasks_archived',
        'idx_tasks_lease',
        'idx_tasks_group',
        'idx_tasks_parent',
      ]) {
        expect(taskIndexNames.has(name)).toBe(true);
      }
      for (const gone of ['idx_tasks_review_batch_status', 'idx_tasks_review_batch_archived']) {
        expect(taskIndexNames.has(gone)).toBe(false);
      }
      // ⑦ 0023：`reviews.reviewer_run_id` 列与它的索引随批次链删除，索引只剩既有一条。
      const reviewIndexes = probe
        .prepare(`SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'reviews'`)
        .all() as { name: string }[];
      expect(
        reviewIndexes.map((row) => row.name).filter((name) => !name.startsWith('sqlite_autoindex_')).sort(),
      ).toEqual(['idx_reviews_task']);
      // notifications 的两条索引一条不少（0001 部分索引 + 0007 追加那条）。
      const notifIndexes = probe
        .prepare(`SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'notifications'`)
        .all() as { name: string }[];
      expect(
        notifIndexes.map((row) => row.name).filter((name) => !name.startsWith('sqlite_autoindex_')).sort(),
      ).toEqual(['idx_notif_read', 'idx_notif_unread']);
      // ⑧ 重建 + 删列后的库必须干净：整库一致性 ok、无外键违例（重建期外键是关的，这里补验）。
      expect(Object.values(probe.prepare('PRAGMA integrity_check').get() as Record<string, string>)).toEqual(['ok']);
      expect(probe.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
      // ⑨ 0021 第 4 段（N32 稳健追加）的 A 行：0001:203 那条**用户从未改过**的五词种子行先被
      //    追加成六词，再被 0023 第 5-c 段把「审核」摘回五词——终值 = 新的 DEFAULT_TASK_TYPES，
      //    与 fresh 全量重放同一个终值（本文件全量重放那条用例的口径）。
      //    钉住的 updated_at 哨兵值没被动过：两段都只改 value，schema 扩容/收词都不是用户编辑。
      //    B（用户自定义词表）/C（不含该词）两种行与守卫面见后面两条用例。
      const wordlist = probe
        .prepare(`SELECT value, updated_at FROM settings WHERE key = 'task_types'`)
        .get() as { value: string; updated_at: string };
      expect(wordlist.value).toBe('["需求","缺陷","子任务","巡检","重构"]');
      expect(wordlist.updated_at).toBe('2020-01-01 00:00:00');
      expect(decodeSetting('task_types', wordlist.value)).toEqual([...DEFAULT_TASK_TYPES]);
      // 0015：skills.category 以 ALTER ADD COLUMN 落地（不整表重建）、0017/0018 两次重建
      // 收敛列级 CHECK——'' （未分类）与现行 16 叶子放行，词表外值挡住。0015 定稿词表是
      // 12 项（含「开学季」「质量保障」），fresh 重放里它先按旧口径回填，随后由 0017/0018
      // 两次重建收敛为终态（16 叶子）。
      probe.prepare(`INSERT INTO skills (id, name, type) VALUES ('s_ok', 'ok', 'prompt')`).run();
      probe.prepare(`INSERT INTO skills (id, name, type, category) VALUES ('s_cat', 'cat', 'prompt', '开发与实现')`).run();
      expect(() =>
        probe.prepare(`INSERT INTO skills (id, name, type, category) VALUES ('s_bad', 'bad', 'prompt', '审核')`).run(),
      ).toThrow();
      // 0016：预置的历史行（受众词+两个词表词+自由标签混灌）——0015 回填取走「实用工具」后，
      // 残留的第二词表词「推荐」与受众词「官方」也被本迁移洗干净，终值只剩自由标签、原序不变。
      const legacy = probe
        .prepare(`SELECT category, tags FROM skills WHERE id = 's_legacy'`)
        .get() as { category: string; tags: string };
      expect(legacy.category).toBe('实用工具');
      expect(legacy.tags).toBe('["我的标签"]');
      // 0017：词表删「开学季」（12→11）经整表重建收敛 CHECK——
      // ① 防御性洗数：0015 回填按定稿 12 词取走「开学季」的预置行 s_season，拷贝前落 ''，
      //    tags 保持 0016 洗后的自由标签原样；
      expect(
        probe.prepare(`SELECT category, tags FROM skills WHERE id = 's_season'`).get() as {
          category: string;
          tags: string;
        },
      ).toEqual({ category: '', tags: '["考研"]' });
      // ② 新 CHECK 生效：词表内 11 词（0018 后仍是叶子）与 '' 放行，「开学季」这个已作废落点被挡；
      probe.prepare(`INSERT INTO skills (id, name, type, category) VALUES ('s_ok11', 'ok11', 'prompt', '教育学习')`).run();
      expect(() =>
        probe.prepare(`INSERT INTO skills (id, name, type, category) VALUES ('s_retired', 'retired', 'prompt', '开学季')`).run(),
      ).toThrow();
      // ③ 重建保住 skill_versions 的 FK ON DELETE CASCADE：删技能，版本行跟着没。
      probe.prepare(`INSERT INTO skill_versions (id, skill_id, version) VALUES ('sv_cascade', 's_ok11', 'v1')`).run();
      probe.prepare(`DELETE FROM skills WHERE id = 's_ok11'`).run();
      expect(probe.prepare(`SELECT COUNT(*) AS n FROM skill_versions WHERE skill_id = 's_ok11'`).get()).toEqual({ n: 0 });
      // ④ 重建后索引全部就位（idx_skills_status + idx_skills_category；TEXT 主键自带的
      //    sqlite_autoindex_* 不算显式索引，滤掉）。
      const skillIndexes = probe
        .prepare(`SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'skills'`)
        .all() as { name: string }[];
      expect(
        skillIndexes.map((row) => row.name).filter((name) => !name.startsWith('sqlite_autoindex_')).sort(),
      ).toEqual(['idx_skills_category', 'idx_skills_status']);
      // 0018：0925 树化（11→16 叶子、作废「质量保障」）第二次整表重建——
      // ① 拷贝前直映射洗数（Q4：用户行与内置行一起洗，洗数先于拷贝同 0017 姿势）：
      //    预置行 s_qa 的旧值「质量保障」落「质量与安全」，tags 保持 0016 洗后的自由词原样；
      expect(
        probe.prepare(`SELECT category, tags FROM skills WHERE id = 's_qa'`).get() as {
          category: string;
          tags: string;
        },
      ).toEqual({ category: '质量与安全', tags: '["运营自由词"]' });
      // ② 新 CHECK 生效：'' + 16 叶子放行；作废词「质量保障」与纯分组一级词
      //    （编码开发/办公实用/研究分析——有子级的词不可再是叶子值）一律被挡；
      probe.prepare(`INSERT INTO skills (id, name, type, category) VALUES ('s_ok18', 'ok18', 'prompt', '质量与安全')`).run();
      expect(() =>
        probe.prepare(`INSERT INTO skills (id, name, type, category) VALUES ('s_retire_qa', 'retireqa', 'prompt', '质量保障')`).run(),
      ).toThrow();
      expect(() =>
        probe.prepare(`INSERT INTO skills (id, name, type, category) VALUES ('s_group_top', 'grouptop', 'prompt', '编码开发')`).run(),
      ).toThrow();
      // ③ 重建同样保住 skill_versions 的 FK ON DELETE CASCADE（0017 之上再验一次当前形状）：
      probe.prepare(`INSERT INTO skill_versions (id, skill_id, version) VALUES ('sv_cascade18', 's_ok18', 'v1')`).run();
      probe.prepare(`DELETE FROM skills WHERE id = 's_ok18'`).run();
      expect(probe.prepare(`SELECT COUNT(*) AS n FROM skill_versions WHERE skill_id = 's_ok18'`).get()).toEqual({ n: 0 });
      // 0019：内置 35 行逐 id 回填叶子终值（终值 = seed upsert 终值，fresh/增量两路径收敛一致）——
      // rc-tdd 按 coding 目录改判「开发与实现」，其 tags 阶段词从 0015 起一路没被洗过
      // （当时不是词表词、0925 树化后是双角色豁免词，见 skill-categories.ts freeTagsOf 不变量）；
      // code-review 样例的 0015 空落点回填「质量与安全」（作废旧值唯一续位）。
      const backfilled = probe
        .prepare(
          `SELECT id, category, tags FROM skills WHERE id IN ('skl_builtin_code-review', 'skl_builtin_rc-tdd') ORDER BY id`,
        )
        .all() as { id: string; category: string; tags: string }[];
      expect(backfilled).toEqual([
        { id: 'skl_builtin_code-review', category: '质量与安全', tags: '["review","quality"]' },
        { id: 'skl_builtin_rc-tdd', category: '开发与实现', tags: '["开发与实现"]' },
      ]);
      probe.close();
    } finally {
      removeTempDirSync(dir);
      if (previous.data === undefined) delete process.env.ATB_DATA_DIR;
      else process.env.ATB_DATA_DIR = previous.data;
      if (previous.mig === undefined) delete process.env.ATB_MIGRATIONS_DIR;
      else process.env.ATB_MIGRATIONS_DIR = previous.mig;
    }
  });

  /**
   * 0021 第 4 段（N32 稳健追加）的正面演练：草案 §10-29 要求的三种行 + 三道守卫 + 两条升级路径。
   * 姿势照上一条用例——`/tmp` 临时目录 + `ATB_DATA_DIR` + `ATB_MIGRATIONS_DIR`，真库禁写。
   * 这一段只对齐 `DEFAULT_TASK_TYPES` 的口径，**不是回路的承重墙**（§7 约束 14：A2 派生建批绕过词表校验），
   * 所以这里断言的全是「库里那一行文本」的形状，不断言任何批次能不能建起来。
   */
  it('迁移 0021 第 4 段：task_types 生效行缺则末尾追加、已含则逐字不动（A/B/C + 守卫面 + 两条路径）', () => {
    const root = mkdtempSync(path.join(tmpdir(), 'atb-0021-wordlist-'));
    const previous = {
      data: process.env.ATB_DATA_DIR,
      mig: process.env.ATB_MIGRATIONS_DIR,
      logs: process.env.ATB_LOGS_DIR,
    };
    const SEED = '["需求","缺陷","子任务","巡检","重构"]';
    const SIX = '["需求","缺陷","子任务","巡检","重构","审核"]';
    const SENTINEL = '2020-01-01 00:00:00';
    const orders = (count: number) => Array.from({ length: count }, (_, index) => index + 1);
    /**
     * 本棒之上的最高编号，从迁移目录现取而不是写死 21：写死即「谁下一棒加迁移，谁的
     * 全量重放断言就红」（0022 拆解除弱引用时正好踩中一次）。本用例只管 0021 第 4 段，
     * 「fresh 一次跑到顶」与「水位 20 的库只重放 20 以上」两条口径都按这个顶来判。
     */
    // 本用例只管 0021 第 4 段的**追加**口径，所以两条路径的水位都停在 0022：
    // 0023（2026-10-09 裁定移除「Agent 当审核方」整链）会把刚追加的「审核」再摘掉，
    // 让它参与断言就等于把「追加」和「收词」两件事混在一条用例里读不出责任边界。
    // 收词口径（含用户自定义词表不被重写）见下一条「迁移 0023 双路径演练」。
    const cap = 22;
    const top = migrationTop();
    expect(top).toBeGreaterThan(cap);
    const above20 = () => orders(cap).filter((order) => order > 20);
    const dirOf = (name: string): string => {
      const dir = path.join(root, name);
      mkdirSync(dir, { recursive: true });
      return dir;
    };
    const readWordlist = (db: DatabaseSync): { value: string; updated_at: string } | undefined =>
      db.prepare(`SELECT value, updated_at FROM settings WHERE key = 'task_types'`).get() as
        | { value: string; updated_at: string }
        | undefined;
    // 满编 20 词：SETTINGS_SPECS.task_types 的 zod 上限就是 20（contract/settings.ts:31），
    // 追加第 21 词会让整键 parse 失败、用户二十个词一起回落默认值——守卫必须拦住。
    const twentyWords = JSON.stringify(orders(20).map((index) => `类型${index}`));
    type Case = { name: string; from: string | null; to: string; decoded: string[] | null };
    const cases: Case[] = [
      // A 未改过的种子行 → 六词、原序不变、`审核` 在末尾（对字面量，不引用已回到五词的 DEFAULT_TASK_TYPES）。
      { name: 'case-a-seed', from: SEED, to: SIX, decoded: ['需求', '缺陷', '子任务', '巡检', '重构', '审核'] },
      // B 用户自定义过且不含该词 → 两个原词都在、顺序不变，末尾多一个 `审核`（N32 的核心：不重写用户词表）。
      { name: 'case-b-custom', from: '["需求","我的类型"]', to: '["需求","我的类型","审核"]', decoded: ['需求', '我的类型', '审核'] },
      // C 已含该词（不在末尾也算）→ 逐字不动，幂等，不追加第二个。
      { name: 'case-c-has', from: '["需求","审核","缺陷"]', to: '["需求","审核","缺陷"]', decoded: ['需求', '审核', '缺陷'] },
      // D 子串陷阱：表里有「审核任务」**不等于**有「审核」——存在性判据必须是 json_each 的元素等值，
      //    写成 `value LIKE '%"审核"%'` 就把这一行误判成已含、第六词永远加不上。
      { name: 'case-d-substring', from: '["需求","审核任务"]', to: '["需求","审核任务","审核"]', decoded: ['需求', '审核任务', '审核'] },
      // E 坏 JSON（用户手改过库）→ json_valid 守卫原样留着，且整条迁移不炸（无守卫时 malformed JSON 回滚全棒）。
      { name: 'case-e-broken', from: 'not json at all', to: 'not json at all', decoded: null },
      // F 合法 JSON 但不是数组 → json_type 守卫原样留着：往对象上「追加一个词」只会造出读不回来的形状。
      { name: 'case-f-object', from: '{"a": 1}', to: '{"a": 1}', decoded: null },
      // G 满编 20 词 → 不加（见上）。原词一个不少地活着。
      { name: 'case-g-full20', from: twentyWords, to: twentyWords, decoded: JSON.parse(twentyWords) as string[] },
      // H 库里根本没有 task_types 行 → 本段空转，也不替用户补插一行（那时 SettingsService 吃 DEFAULT_SETTINGS）。
      { name: 'case-h-norow', from: null, to: '', decoded: null },
    ];

    try {
      process.env.ATB_LOGS_DIR = path.join(root, 'logs');
      mkdirSync(process.env.ATB_LOGS_DIR, { recursive: true });

      // ── 路径一：fresh 全量重放（空目录一次跑到 0022），种子行同样被追加成六词 ────────────
      // 先把 ≤0022 的迁移子集摆好，两条路径共用（0023 不参与本用例，理由见上）。
      const source = migrationsDir();
      const stagedUpToCap = path.join(root, 'migrations-0022');
      mkdirSync(stagedUpToCap);
      for (const entry of readdirSync(source)) {
        if (/^\d+_/.test(entry) && Number(entry.split('_')[0]) <= cap) {
          cpSync(path.join(source, entry), path.join(stagedUpToCap, entry), { recursive: true });
        }
      }
      const fresh = dirOf('fresh');
      process.env.ATB_DATA_DIR = fresh;
      process.env.ATB_MIGRATIONS_DIR = stagedUpToCap;
      expect(applyMigrations()).toEqual(orders(cap));
      const freshDb = new DatabaseSync(path.join(fresh, 'jarvis.db'));
      expect(freshDb.prepare('PRAGMA user_version').get()).toEqual({ user_version: cap });
      expect(readWordlist(freshDb)?.value).toBe(SIX);
      // 0021 追加口径的解码回读：六词能原样读回 string[]。
      // （DEFAULT_TASK_TYPES 在 0023 之后回到五词，本用例水位停在 0022，所以这里对字面量而不是对默认值。）
      expect(decodeSetting('task_types', SIX)).toEqual(['需求', '缺陷', '子任务', '巡检', '重构', '审核']);
      expect(Object.values(freshDb.prepare('PRAGMA integrity_check').get() as Record<string, string>)).toEqual(['ok']);
      expect(freshDb.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
      freshDb.close();
      expect(applyMigrations()).toEqual([]); // 二次 applyMigrations() 幂等空转
      const freshAgain = new DatabaseSync(path.join(fresh, 'jarvis.db'), { readOnly: true });
      expect(freshAgain.prepare(`SELECT value FROM settings WHERE key = 'task_types'`).get()).toEqual({ value: SIX });
      freshAgain.close();

      // ── 路径二：水位 0020 的既有库只重放 20 之上、0022 及以下的编号，逐条换 task_types 行 ──
      // 先用 0001~0020 子集造一个「升级前的库」模板，再按用例复制成副本库（真库禁写）。
      const staged = path.join(root, 'migrations-0020');
      mkdirSync(staged);
      for (const entry of readdirSync(source)) {
        if (/^\d+_/.test(entry) && Number(entry.split('_')[0]) <= 20) {
          cpSync(path.join(source, entry), path.join(staged, entry), { recursive: true });
        }
      }
      const template = dirOf('template');
      process.env.ATB_DATA_DIR = template;
      process.env.ATB_MIGRATIONS_DIR = staged;
      expect(applyMigrations()).toEqual(orders(20));

      // 第 4 段是本文件**最后一条语句**：单独摘出来重跑，直接验「已含就不再写」的语句面幂等
      // （不经水位，与上面 applyMigrations() 的二次空转互补）。
      const migration21Dir = readdirSync(source).find((name) => /^0021_/.test(name));
      expect(typeof migration21Dir).toBe('string');
      const migration21 = readFileSync(path.join(source, migration21Dir as string, 'migration.sql'), 'utf8');
      const cut = migration21.lastIndexOf('\nUPDATE settings');
      expect(cut).toBeGreaterThan(-1);
      const appendOnce = migration21.slice(cut + 1);

      for (const testCase of cases) {
        const dir = dirOf(testCase.name);
        cpSync(path.join(template, 'jarvis.db'), path.join(dir, 'jarvis.db'));
        const before = new DatabaseSync(path.join(dir, 'jarvis.db'));
        expect(before.prepare('PRAGMA user_version').get()).toEqual({ user_version: 20 });
        // 除 task_types 之外的生效行整体留档：本段只能碰 task_types 那一行。
        const others = before
          .prepare(`SELECT key, value FROM settings WHERE key <> 'task_types' ORDER BY key`)
          .all() as { key: string; value: string }[];
        expect(others.length).toBeGreaterThan(0);
        if (testCase.from === null) {
          before.prepare(`DELETE FROM settings WHERE key = 'task_types'`).run();
        } else {
          before
            .prepare(`UPDATE settings SET value = ?, updated_at = ? WHERE key = 'task_types'`)
            .run(testCase.from, SENTINEL);
        }
        before.close();

        process.env.ATB_MIGRATIONS_DIR = stagedUpToCap; // 0022 子集：水位 20 → 只重放 20 之上、22 及以下的编号
        process.env.ATB_DATA_DIR = dir;
        expect(applyMigrations()).toEqual(above20());
        expect(applyMigrations()).toEqual([]);

        const after = new DatabaseSync(path.join(dir, 'jarvis.db'));
        const row = readWordlist(after);
        if (testCase.from === null) {
          // H：无行 → 本段什么都不做（不追加、也不插一行）。口径天然一致的证据在最后一行。
          expect(row).toBeUndefined();
          expect(after.prepare(`SELECT COUNT(*) AS n FROM settings WHERE key = 'task_types'`).get()).toEqual({ n: 0 });
        } else {
          expect(row).toBeDefined();
          expect(row!.value).toBe(testCase.to);
          expect(row!.updated_at).toBe(SENTINEL); // 不给 updated_at 赋值：哨兵值原样留着
          if (testCase.decoded) {
            expect(decodeSetting('task_types', row!.value)).toEqual(testCase.decoded);
          }
          // 幂等：同一条 UPDATE 再跑两次，值与 updated_at 都不动（E/F/G 同时再验一次守卫不炸）。
          after.exec(appendOnce);
          after.exec(appendOnce);
          expect(readWordlist(after)).toEqual(row);
        }
        expect(after.prepare(`SELECT key, value FROM settings WHERE key <> 'task_types' ORDER BY key`).all()).toEqual(others);
        expect(after.prepare('PRAGMA user_version').get()).toEqual({ user_version: cap });
        expect(Object.values(after.prepare('PRAGMA integrity_check').get() as Record<string, string>)).toEqual(['ok']);
        expect(after.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
        after.close();
      }

      // H 行为什么不需要补插：无行时 SettingsService 吃 DEFAULT_SETTINGS。
      // 0023 之后代码默认词表已不含「审核」（DEFAULT_TASK_TYPES 回到五词），
      // 所以「有行 → 摘词」与「无行 → 吃默认」两条口径在 0023 之后天然同为五词。
      expect([...DEFAULT_TASK_TYPES]).not.toContain('审核');
      expect([...DEFAULT_TASK_TYPES]).toEqual(['需求', '缺陷', '子任务', '巡检', '重构']);
    } finally {
      removeTempDirSync(root);
      if (previous.data === undefined) delete process.env.ATB_DATA_DIR;
      else process.env.ATB_DATA_DIR = previous.data;
      if (previous.mig === undefined) delete process.env.ATB_MIGRATIONS_DIR;
      else process.env.ATB_MIGRATIONS_DIR = previous.mig;
      if (previous.logs === undefined) delete process.env.ATB_LOGS_DIR;
      else process.env.ATB_LOGS_DIR = previous.logs;
    }
  });

  /**
   * 迁移 0023（2026-10-09 裁定「Agent 当审核方」整链移除，见清单 §14）的双路径演练。
   *
   * 这是 §14 判据③的仓内落点：`review_track` / `review_batch` / `reviewer_run_id` 三列 +
   * `reviewer_type` + 「审核」类型词 + 两枚 `review_auto_*` kind + 四个审核设置键，
   * 在 schema、`sqlite_master`、settings 生效行三处同步归零；同时按裁定第 2 条的边界澄清，
   * `tasks` / `reviews` 的**其他业务列逐字零丢失**。
   *
   * 两条路径都必须在 /tmp 里跑（真库 `~/.agent-board` 绝对禁写）：
   *  · 全新建库：0001~0023 一次跑到顶；
   *  · 存量升级：0001~0022 造模板库 + 灌一批 0022 形状的审核数据，再只重放 0023。
   * 两库终态逐字一致（列集合、CHECK 词表文本、索引名集合三项对齐）。
   */
  it('迁移 0023 双路径：审核列/索引/词表/设置键归零，业务数据零丢失', () => {
    const root = mkdtempSync(path.join(tmpdir(), 'atb-0023-'));
    const previous = {
      data: process.env.ATB_DATA_DIR,
      mig: process.env.ATB_MIGRATIONS_DIR,
      logs: process.env.ATB_LOGS_DIR,
    };
    const orders2 = (count: number) => Array.from({ length: count }, (_, index) => index + 1);
    const top = migrationTop();
    const source = migrationsDir();
    const stageUpTo = (cap: number, name: string): string => {
      const dir = path.join(root, name);
      mkdirSync(dir);
      for (const entry of readdirSync(source)) {
        if (/^\d+_/.test(entry) && Number(entry.split('_')[0]) <= cap) {
          cpSync(path.join(source, entry), path.join(dir, entry), { recursive: true });
        }
      }
      return dir;
    };
    /** 表定义原文（含 CHECK 词表）——fresh 与增量两条路径必须逐字相同。 */
    const tableSql = (db: DatabaseSync, table: string): string =>
      (db.prepare(`SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?`).get(table) as {
        sql: string;
      }).sql;
    /** 显式索引名集合（`sqlite_autoindex_*` 是主键/表级 UNIQUE 自带的，不计）。 */
    const indexNames = (db: DatabaseSync, table: string): string[] =>
      (db.prepare(`SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = ?`).all(table) as {
        name: string;
      }[])
        .map((row) => row.name)
        .filter((name) => !name.startsWith('sqlite_autoindex_'))
        .sort();
    const columnNames = (db: DatabaseSync, table: string): string[] =>
      (db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]).map((row) => row.name);

    /**
     * 0022 形状的存量审核数据（随 v0.0.4-beta.9 出去的那个库的真实可能形状）：
     * 一支等 Agent 审的任务、一支免审直通、一支人审已过并署了名、一条 review 纯标记边、
     * 两枚自动审核通知、四个审核设置键 + default_review_mode='auto' + 用户自己排的词表（含「审核」）。
     * updated_at 一律钉哨兵值：0023 不洗业务时间戳（0009~0022 同口径）。
     */
    const SENTINEL = '2020-01-01 00:00:00';
    const seedLegacy = (db: DatabaseSync) => {
      db.prepare(
        `INSERT INTO tasks (id, type, title, description, status, priority, tags, pinned, due_at,
                            lease_id, stop_reason, current_run_id, run_count, created_at, updated_at,
                            parent_task_id, sort_order, skills, origin_type, origin_agent, origin_skill,
                            origin_session_id, confirmation_mode, review_mode, review_track, review_batch)
         VALUES ('t_auto', '需求', '等 Agent 审的那支', '存量描述', 'REVIEW', 1, '["支付","核心"]', 1,
                 '2026-12-31 00:00:00', NULL, NULL, 'run_legacy', 2, '2026-01-01 00:00:00', ?,
                 NULL, 7, '[{"skill_id":"skl_builtin_code-review","version":"1"}]', 'agent', 'qoder', '代码评审',
                 'conv-legacy', 'light', 'auto', 'auto', 0)`,
      ).run(SENTINEL);
      db.prepare(
        `INSERT INTO tasks (id, title, status, review_mode, review_track, created_at, updated_at)
         VALUES ('t_none', '免审直通', 'DONE', 'none', 'human', '2026-01-02 00:00:00', ?)`,
      ).run(SENTINEL);
      db.prepare(
        `INSERT INTO tasks (id, title, status, review_mode, review_track, review_batch, type, updated_at)
         VALUES ('t_batch', '审核批次（第六版死列的产物）', 'REVIEW', 'auto', 'auto', 1, '审核', ?)`,
      ).run(SENTINEL);
      db.prepare(
        `INSERT INTO reviews (id, task_id, conclusion, suggestion, reason, detail, return_to,
                              priority_adj, created_at, reviewer_name, reviewer_type, reviewer_run_id)
         VALUES ('r_agent', 't_batch', 'APPROVE', '建议原文', '理由原文', '细节原文', NULL, NULL,
                 '2026-01-03 00:00:00', 'bot-token-name', 'agent', 'run_batch_legacy')`,
      ).run();
      db.prepare(
        `INSERT INTO reviews (id, task_id, conclusion, suggestion, reason, detail, return_to, priority_adj, created_at)
         VALUES ('r_human', 't_auto', 'REJECT', '补单测', '缺回归用例', '详见流水线', 'BACKLOG', 0, '2026-01-04 00:00:00')`,
      ).run();
      db.prepare(
        `INSERT INTO task_dependencies (id, task_id, depends_on, type, created_at)
         VALUES ('d_review', 't_batch', 't_auto', 'review', '2026-01-05 00:00:00')`,
      ).run();
      db.prepare(
        `INSERT INTO task_dependencies (id, task_id, depends_on, type, created_at)
         VALUES ('d_blocks', 't_auto', 't_none', 'blocks', '2026-01-06 00:00:00')`,
      ).run();
      db.prepare(
        `INSERT INTO notifications (id, kind, task_id, message, created_at)
         VALUES ('n_auto_p', 'review_auto_pending', 't_auto', '等待自动审核', '2026-01-07 00:00:00')`,
      ).run();
      db.prepare(
        `INSERT INTO notifications (id, kind, task_id, message, created_at)
         VALUES ('n_auto_q', 'review_auto_passed', 't_batch', '自动审核通过', '2026-01-08 00:00:00')`,
      ).run();
      db.prepare(
        `INSERT INTO notifications (id, kind, task_id, message, created_at)
         VALUES ('n_pending', 'review_pending', 't_auto', '任务已完成，等待审核', '2026-01-09 00:00:00')`,
      ).run();
      // 设置生效行：SettingsService「有行用行」，所以键与词表都必须在迁移里处理（0021 同论证）。
      db.prepare(
        `INSERT INTO settings (key, value, updated_at) VALUES
          ('review_auto_dispatch', 'true', ?),
          ('review_batch_max_targets', '5', ?),
          ('review_max_rounds', '3', ?),
          ('review_rubric_skill', '"skl_builtin_code-review"', ?),
          ('default_review_mode', '"auto"', ?)`,
      ).run(SENTINEL, SENTINEL, SENTINEL, SENTINEL, SENTINEL);
      // 用户自己排过的词表（顺序与既有词都要活着）：0023 只摘「审核」这一个元素。
      // updated_at 钉哨兵值：本段只该改 value，收词不是用户编辑（0009~0022 同口径）。
      db.prepare(
        `UPDATE settings SET value = '["需求","我的类型","审核","巡检"]', updated_at = ? WHERE key = 'task_types'`,
      ).run(SENTINEL);
    };
    /** 升级前抓一份业务列快照，升级后逐字比对（裁定第 2 条：其他业务数据零丢失）。 */
    const businessSnapshot = (db: DatabaseSync) =>
      db
        .prepare(
          `SELECT id, type, title, description, status, priority, tags, pinned, due_at, current_run_id,
                  run_count, created_at, updated_at, sort_order, skills, origin_type, origin_agent,
                  origin_skill, origin_session_id, confirmation_mode
           FROM tasks ORDER BY id`,
        )
        .all();
    const reviewSnapshot = (db: DatabaseSync) =>
      db
        .prepare(
          `SELECT id, task_id, run_id, conclusion, suggestion, reason, detail, return_to, priority_adj,
                  created_at, reviewer_name
           FROM reviews ORDER BY id`,
        )
        .all();

    try {
      process.env.ATB_LOGS_DIR = path.join(root, 'logs');
      mkdirSync(process.env.ATB_LOGS_DIR, { recursive: true });

      // ── 路径一：全新建库（0001~0023 一次跑到顶） ──────────────────────────────────
      const fresh = path.join(root, 'fresh');
      mkdirSync(fresh);
      process.env.ATB_DATA_DIR = fresh;
      delete process.env.ATB_MIGRATIONS_DIR; // 仓库全量目录
      expect(applyMigrations()).toEqual(orders2(top));
      const freshDb = new DatabaseSync(path.join(fresh, 'jarvis.db'));
      expect(freshDb.prepare('PRAGMA user_version').get()).toEqual({ user_version: top });

      // ── 路径二：0022 存量库只重放 0023 ───────────────────────────────────────────
      const upgraded = path.join(root, 'upgraded');
      mkdirSync(upgraded);
      process.env.ATB_DATA_DIR = upgraded;
      process.env.ATB_MIGRATIONS_DIR = stageUpTo(22, 'migrations-0022');
      expect(applyMigrations()).toEqual(orders2(22));
      const before = new DatabaseSync(path.join(upgraded, 'jarvis.db'));
      seedLegacy(before);
      const tasksBefore = businessSnapshot(before);
      const reviewsBefore = reviewSnapshot(before);
      expect(tasksBefore).toHaveLength(3);
      expect(reviewsBefore).toHaveLength(2);
      // 升级前的形状自检：确实在演 0022 的形状，而不是不小心演了一个已经拆过的库。
      expect(columnNames(before, 'tasks')).toContain('review_track');
      expect(columnNames(before, 'reviews')).toContain('reviewer_type');
      before.close();

      delete process.env.ATB_MIGRATIONS_DIR; // 切回全量目录：水位 22 → 只重放 0023
      expect(applyMigrations()).toEqual([23]);
      expect(applyMigrations()).toEqual([]); // 二次空转（幂等）

      const db = new DatabaseSync(path.join(upgraded, 'jarvis.db'));

      // ① 三列 + reviewer_type 在 sqlite_master 里彻底不存在（判据③）。
      for (const [table, column] of [
        ['tasks', 'review_track'],
        ['tasks', 'review_batch'],
        ['reviews', 'reviewer_run_id'],
        ['reviews', 'reviewer_type'],
      ] as const) {
        expect(columnNames(db, table), `${table}.${column}`).not.toContain(column);
      }
      expect(columnNames(db, 'tasks')).toContain('review_mode');
      // `reviews.reviewer_name` 保留：它是「这条结论谁给的」唯一署名位，人审复用位（依据见 0023 第 2 段注释）。
      expect(columnNames(db, 'reviews')).toContain('reviewer_name');

      // ② 存量 `review_mode='auto'` 归 human（回「结果强制人工审核」现状），不批量免审。
      expect(db.prepare(`SELECT review_mode FROM tasks WHERE id = 't_auto'`).get()).toEqual({ review_mode: 'human' });
      expect(db.prepare(`SELECT review_mode FROM tasks WHERE id = 't_batch'`).get()).toEqual({ review_mode: 'human' });
      // none 支一字不变（免审直通路的行为不许被动摇）。
      expect(db.prepare(`SELECT review_mode FROM tasks WHERE id = 't_none'`).get()).toEqual({ review_mode: 'none' });

      // ③ 其他业务列逐字零丢失（裁定第 2 条的边界澄清）。唯一例外是 `type` 列：
      //    t_batch 的「审核」由本迁移第 6 段回落到列默认值 '需求'（D1 实测缺陷：5-c 摘词后
      //    这类行若不动，PATCH 原样带 type 也会被生效词表拒成 422），其余列与其余行一字不差。
      const tasksExpectedAfter = (tasksBefore as { id: string; type: string }[]).map((row) =>
        row.type === '审核' ? { ...row, type: '需求' } : row,
      );
      expect(businessSnapshot(db)).toEqual(tasksExpectedAfter);
      expect(db.prepare(`SELECT type FROM tasks WHERE id = 't_batch'`).get()).toEqual({ type: '需求' });
      expect(db.prepare(`SELECT COUNT(*) AS n FROM tasks WHERE type = '审核'`).get()).toEqual({ n: 0 });
      expect(reviewSnapshot(db)).toEqual(reviewsBefore);
      // 存量审核行本体不删：r_agent 那条只是失去来源标记，结论文案与署名照旧。
      expect(db.prepare(`SELECT COUNT(*) AS n FROM reviews`).get()).toEqual({ n: 2 });

      // ④ `type='review'` 的纯标记边删除，blocks 边零丢失。
      expect(
        db.prepare(`SELECT id, task_id, depends_on, type FROM task_dependencies ORDER BY id`).all(),
      ).toEqual([{ id: 'd_blocks', task_id: 't_auto', depends_on: 't_none', type: 'blocks' }]);

      // ⑤ 两枚自动审核通知删除，其余 kind 零丢失（不改写成 review_pending——那是假账）。
      expect(
        db.prepare(`SELECT id, kind FROM notifications ORDER BY id`).all(),
      ).toEqual([{ id: 'n_pending', kind: 'review_pending' }]);

      // ⑥ 四个审核设置键的**生效行**删除（只改代码默认值管不到库里那行）。
      expect(
        db.prepare(`SELECT COUNT(*) AS n FROM settings WHERE key IN
          ('review_auto_dispatch','review_batch_max_targets','review_max_rounds','review_rubric_skill')`).get(),
      ).toEqual({ n: 0 });
      // default_review_mode 键保留、取值归 'human'（与 ② 同一条判据）。
      expect(db.prepare(`SELECT value FROM settings WHERE key = 'default_review_mode'`).get()).toEqual({ value: '"human"' });
      // 用户词表只摘「审核」这一个元素：其余词与原序一字不动（整串替换会把用户资产洗成默认）。
      const wordlist = db.prepare(`SELECT value, updated_at FROM settings WHERE key = 'task_types'`).get() as {
        value: string;
        updated_at: string;
      };
      expect(wordlist.value).toBe('["需求","我的类型","巡检"]');
      expect(decodeSetting('task_types', wordlist.value)).toEqual(['需求', '我的类型', '巡检']);
      expect(
        db.prepare(`SELECT COUNT(*) AS n FROM settings WHERE key = 'task_types' AND updated_at <> ?`).get(SENTINEL),
      ).toEqual({ n: 0 });

      // ⑦ CHECK 词表收窄到位：review_mode 只放行 human/none、kind 只放行六词、deps 只放行两值。
      expect(() => db.prepare(`INSERT INTO tasks (id, title, review_mode) VALUES ('x1', 'x', 'auto')`).run()).toThrow();
      db.prepare(`INSERT INTO tasks (id, title, review_mode) VALUES ('x1', 'x', 'none')`).run();
      db.prepare(`INSERT INTO tasks (id, title, review_mode) VALUES ('x4', 'x', 'human')`).run();
      expect(() =>
        db.prepare(`INSERT INTO notifications (id, kind, message) VALUES ('x2', 'review_auto_pending', 'x')`).run(),
      ).toThrow();
      expect(() =>
        db.prepare(`INSERT INTO task_dependencies (id, task_id, depends_on, type) VALUES ('x3', 't_auto', 't_none', 'review')`).run(),
      ).toThrow();

      // ⑧ 索引集合：删掉的三条随列一起没了，其余一条不少且名字一致（验收会去 sqlite_master 数）。
      expect(indexNames(db, 'tasks')).toEqual([
        'idx_tasks_archived',
        'idx_tasks_group',
        'idx_tasks_lease',
        'idx_tasks_parent',
        'idx_tasks_ready',
        'idx_tasks_status',
      ]);
      expect(indexNames(db, 'reviews')).toEqual(['idx_reviews_task']);
      expect(indexNames(db, 'task_dependencies')).toEqual(['idx_deps_depends_on', 'idx_deps_task']);
      expect(indexNames(db, 'notifications')).toEqual(['idx_notif_read', 'idx_notif_unread']);

      // ⑨ 部分索引活着（重建最容易丢的就是 WHERE 条件那半截）。
      expect(
        (db.prepare(`SELECT name, sql FROM sqlite_master WHERE type = 'index' AND name IN ('idx_tasks_lease','idx_notif_unread')`).all() as {
          name: string;
          sql: string;
        }[]).map((row) => row.sql),
      ).toEqual([
        'CREATE INDEX idx_tasks_lease ON tasks(lease_expires_at) WHERE status = \'RUNNING\'',
        'CREATE INDEX idx_notif_unread ON notifications(read_at) WHERE read_at IS NULL',
      ]);

      // ⑩ 库干净：重建期外键是关的，这里补验无违例。
      expect(Object.values(db.prepare('PRAGMA integrity_check').get() as Record<string, string>)).toEqual(['ok']);
      expect(db.prepare('PRAGMA foreign_key_check').all()).toEqual([]);

      // ⑪ 双路径终值一致：四张表的 DDL 原文与索引集合逐字相同。
      for (const table of ['tasks', 'reviews', 'task_dependencies', 'notifications']) {
        expect(tableSql(db, table), `${table} DDL`).toBe(tableSql(freshDb, table));
        expect(indexNames(db, table), `${table} 索引`).toEqual(indexNames(freshDb, table));
        expect(columnNames(db, table), `${table} 列`).toEqual(columnNames(freshDb, table));
      }
      // fresh 路径的词表种子行同样是五词（0001 五词 → 0021 追加六词 → 0023 摘回五词）。
      expect(freshDb.prepare(`SELECT value FROM settings WHERE key = 'task_types'`).get()).toEqual({
        value: '["需求","缺陷","子任务","巡检","重构"]',
      });
      // 四个审核键在 fresh 路径也不该有行（0001 从未种过它们，0023 又删了增量库里的生效行）。
      // 注意别写成 `key LIKE 'review_%'`：`review_reuse_last_opinion` 是人审侧的活键，必须活着。
      expect(
        freshDb.prepare(
          `SELECT COUNT(*) AS n FROM settings WHERE key IN
             ('review_auto_dispatch','review_batch_max_targets','review_max_rounds','review_rubric_skill')`,
        ).get(),
      ).toEqual({ n: 0 });
      expect(freshDb.prepare(`SELECT value FROM settings WHERE key = 'review_reuse_last_opinion'`).get()).toEqual({
        value: 'true',
      });

      db.close();
      freshDb.close();
    } finally {
      removeTempDirSync(root);
      if (previous.data === undefined) delete process.env.ATB_DATA_DIR;
      else process.env.ATB_DATA_DIR = previous.data;
      if (previous.mig === undefined) delete process.env.ATB_MIGRATIONS_DIR;
      else process.env.ATB_MIGRATIONS_DIR = previous.mig;
      if (previous.logs === undefined) delete process.env.ATB_LOGS_DIR;
      else process.env.ATB_LOGS_DIR = previous.logs;
    }
  });

  it('迁移 0023 第 6 段：tasks.type「审核」存量行回落「需求」（①命中改写 ②无命中空转 ③邻行一字不动）', () => {
    const root = mkdtempSync(path.join(tmpdir(), 'atb-0023-type-'));
    const previous = {
      data: process.env.ATB_DATA_DIR,
      mig: process.env.ATB_MIGRATIONS_DIR,
      logs: process.env.ATB_LOGS_DIR,
    };
    const orders3 = (count: number) => Array.from({ length: count }, (_, index) => index + 1);
    const source = migrationsDir();
    const stageUpTo = (cap: number, name: string): string => {
      const dir = path.join(root, name);
      mkdirSync(dir);
      for (const entry of readdirSync(source)) {
        if (/^\d+_/.test(entry) && Number(entry.split('_')[0]) <= cap) {
          cpSync(path.join(source, entry), path.join(dir, entry), { recursive: true });
        }
      }
      return dir;
    };
    const SENTINEL = '2020-01-01 00:00:00';
    // 显式列清单只取 0023 之后仍幸存的列（review_track/review_batch 的删除面归上面双路径用例管），
    // 本用例专注第 6 段的洗数口径：命中行回落、邻行与时间戳一字不动。
    const taskRows = (db: DatabaseSync): Record<string, unknown>[] =>
      db
        .prepare(
          `SELECT id, type, title, description, status, priority, tags, required_capabilities,
                  custom_fields, pinned, due_at, archived_at, stop_reason, current_run_id, run_count,
                  created_at, updated_at, group_id, parent_task_id, sort_order, skills, origin_type,
                  origin_agent, origin_skill, origin_session_id, confirmation_mode, review_mode
           FROM tasks ORDER BY id`,
        )
        .all() as Record<string, unknown>[];
    const wordlistRow = (db: DatabaseSync): { value: string; updated_at: string } =>
      db.prepare(`SELECT value, updated_at FROM settings WHERE key = 'task_types'`).get() as {
        value: string;
        updated_at: string;
      };

    try {
      process.env.ATB_LOGS_DIR = path.join(root, 'logs');
      mkdirSync(process.env.ATB_LOGS_DIR, { recursive: true });

      // ── 库 A：0022 存量 + 词表含「审核」+ 有 type='审核' 行（形状① + ③）────────────
      // t_shencha 是 D1 实测的场景：用户在界面下拉（读 0021 追加后的词表）手建的普通任务。
      // t_shencha_zhong 是守卫面：含「审核」子串的用户自定义类型，精确等值判据不许误伤。
      const hit = path.join(root, 'hit');
      mkdirSync(hit);
      process.env.ATB_DATA_DIR = hit;
      process.env.ATB_MIGRATIONS_DIR = stageUpTo(22, 'migrations-0022');
      expect(applyMigrations()).toEqual(orders3(22));
      const dbA = new DatabaseSync(path.join(hit, 'jarvis.db'));
      dbA.prepare(
        `INSERT INTO tasks (id, type, title, status, created_at, updated_at) VALUES
          ('t_shencha',       '审核',   '帮我评审这份方案', 'BACKLOG', '2026-01-01 00:00:00', ?),
          ('t_shencha_zhong', '审核中', '用户自定义类型（含「审核」子串）', 'BACKLOG', '2026-01-02 00:00:00', ?),
          ('t_bug',           '缺陷',   '登录页空指针',     'BACKLOG', '2026-01-03 00:00:00', ?)`,
      ).run(SENTINEL, SENTINEL, SENTINEL);
      // 词表是用户资产：既含 0021 追加的「审核」，也含用户自己加的「审核中」。updated_at 钉哨兵值。
      dbA.prepare(`UPDATE settings SET value = '["需求","缺陷","子任务","巡检","重构","审核","审核中"]', updated_at = ? WHERE key = 'task_types'`).run(SENTINEL);
      const rowsBeforeA = taskRows(dbA);
      expect(rowsBeforeA).toHaveLength(3);

      delete process.env.ATB_MIGRATIONS_DIR; // 水位 22 → 只重放 0023（含新第 6 段）
      expect(applyMigrations()).toEqual([23]);
      expect(applyMigrations()).toEqual([]); // 二次空转（幂等）

      // ① 命中行落在回落目标：type='审核' → '需求'（列 DDL 默认值 / DEFAULT_TASK_TYPES[0]），
      //    且不是「凭空造词」——回落值必须在生效词表内（见下面 PATCH 谓词断言）。
      expect(dbA.prepare(`SELECT type FROM tasks WHERE id = 't_shencha'`).get()).toEqual({ type: '需求' });
      expect(dbA.prepare(`SELECT COUNT(*) AS n FROM tasks WHERE type = '审核'`).get()).toEqual({ n: 0 });
      // 第 6 段不动 updated_at（洗数不是用户编辑，0009~0022 同口径）。
      expect(
        dbA.prepare(`SELECT COUNT(*) AS n FROM tasks WHERE updated_at <> ?`).get(SENTINEL),
      ).toEqual({ n: 0 });

      // ③ 用户其它类型行一字不动：整行快照只允许 t_shencha 的 type 一处差异。
      const rowsAfterA = taskRows(dbA);
      expect(rowsAfterA).toEqual(
        (rowsBeforeA as { id: string; type: string }[]).map((row) =>
          row.type === '审核' ? { ...row, type: '需求' } : row,
        ),
      );
      // 「审核中」活着：守卫是精确等值 `type = '审核'`，不是 LIKE（判据同 5-c 的元素等值）。
      expect(dbA.prepare(`SELECT type FROM tasks WHERE id = 't_shencha_zhong'`).get()).toEqual({ type: '审核中' });

      // 5-c 与第 6 段的配对面：词表只摘精确元素「审核」，「审核中」与其余词、原序一字不动。
      const wordlistA = wordlistRow(dbA);
      expect(wordlistA.value).toBe('["需求","缺陷","子任务","巡检","重构","审核中"]');
      expect(wordlistA.updated_at).toBe(SENTINEL);

      // PATCH 谓词面（tasks.service.ts:252-259：`types.includes(input.type)` 不中就 422
      // 「任务类型「审核」不在词表内」）：升级后每一行的 type 都在生效词表里 ⇒ 用户 PATCH 这条
      // 任务时**原样带行上的当前 type** 不再被拒——D1 实测的那条「正常任务从此改不动」被收口。
      const vocabularyA = decodeSetting('task_types', wordlistA.value) as string[];
      expect(vocabularyA).not.toContain('审核');
      for (const row of rowsAfterA as { type: string }[]) {
        expect(vocabularyA).toContain(row.type);
      }
      expect(Object.values(dbA.prepare('PRAGMA integrity_check').get() as Record<string, string>)).toEqual(['ok']);
      expect(dbA.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
      dbA.close();

      // ── 库 B：词表本无「审核」且无命中行 → 幂等空转，一行都不许被误改（形状②）────────
      const idle = path.join(root, 'idle');
      mkdirSync(idle);
      process.env.ATB_DATA_DIR = idle;
      process.env.ATB_MIGRATIONS_DIR = path.join(root, 'migrations-0022');
      expect(applyMigrations()).toEqual(orders3(22));
      const dbB = new DatabaseSync(path.join(idle, 'jarvis.db'));
      dbB.prepare(
        `INSERT INTO tasks (id, type, title, status, created_at, updated_at) VALUES
          ('t_ok1', '需求',   '正常需求行',     'BACKLOG', '2026-01-01 00:00:00', ?),
          ('t_ok2', '缺陷',   '正常缺陷行',     'BACKLOG', '2026-01-02 00:00:00', ?),
          ('t_ok3', '审核过', '含子串的非命中行', 'BACKLOG', '2026-01-03 00:00:00', ?)`,
      ).run(SENTINEL, SENTINEL, SENTINEL);
      const wordlistB = '["需求","缺陷","子任务","巡检","重构","开学季"]';
      dbB.prepare(`UPDATE settings SET value = ?, updated_at = ? WHERE key = 'task_types'`).run(wordlistB, SENTINEL);
      const rowsBeforeB = taskRows(dbB);

      delete process.env.ATB_MIGRATIONS_DIR;
      expect(applyMigrations()).toEqual([23]);

      // 空转结论：tasks 整表逐字节快照一字不动，词表行一字不动（5-c 的 EXISTS 守卫 + 第 6 段
      // 的等值守卫各自拦住——没有精确命中的词/行时不写库，用户资产零损伤）。
      expect(taskRows(dbB)).toEqual(rowsBeforeB);
      expect(wordlistRow(dbB)).toEqual({ value: wordlistB, updated_at: SENTINEL });
      expect(dbB.prepare(`SELECT COUNT(*) AS n FROM tasks WHERE type = '审核'`).get()).toEqual({ n: 0 });
      dbB.close();
    } finally {
      removeTempDirSync(root);
      if (previous.data === undefined) delete process.env.ATB_DATA_DIR;
      else process.env.ATB_DATA_DIR = previous.data;
      if (previous.mig === undefined) delete process.env.ATB_MIGRATIONS_DIR;
      else process.env.ATB_MIGRATIONS_DIR = previous.mig;
      if (previous.logs === undefined) delete process.env.ATB_LOGS_DIR;
      else process.env.ATB_LOGS_DIR = previous.logs;
    }
  });

  it('列语义落库校验：origin_type 默认 user、CHECK 词表、session_id 唯一', async () => {
    const seedId = await h.prisma.$queryRawUnsafe<{ id: string }[]>(
      `SELECT 'mig_probe' AS id`,
    );
    expect(seedId[0]!.id).toBe('mig_probe');
    // 无 origin_type 的插入吃列默认 'user'（存量/非 Agent 入口天然来源）。
    await h.prisma.$executeRawUnsafe(
      `INSERT INTO tasks (id, type, title) VALUES ('mig_t1', '缺陷', '默认来源')`,
    );
    const row = await h.prisma.$queryRawUnsafe<{ origin_type: string | null }[]>(
      `SELECT origin_type FROM tasks WHERE id = 'mig_t1'`,
    );
    expect(row[0]!.origin_type).toBe('user');
    // origin_type / confirmation_mode 词表 CHECK 生效。
    await expect(
      h.prisma.$executeRawUnsafe(
        `INSERT INTO tasks (id, type, title, origin_type) VALUES ('mig_t2', '缺陷', 'x', 'robot')`,
      ),
    ).rejects.toThrow();
    await expect(
      h.prisma.$executeRawUnsafe(
        `INSERT INTO tasks (id, type, title, confirmation_mode) VALUES ('mig_t3', '缺陷', 'x', 'whisper')`,
      ),
    ).rejects.toThrow();
    // agent_sessions 按 session_id 唯一（§8.7 upsert 坐标）。
    await h.prisma.$executeRawUnsafe(
      `INSERT INTO agent_sessions (id, session_id, agent_name) VALUES ('as_m1', 'conv-mig', 'a')`,
    );
    await expect(
      h.prisma.$executeRawUnsafe(
        `INSERT INTO agent_sessions (id, session_id, agent_name) VALUES ('as_m2', 'conv-mig', 'b')`,
      ),
    ).rejects.toThrow();
  });
});

// ---------------------------------------------------------------- 2. 直建 / 静默两模式

describe('board.create_task 直接创建（direct）', () => {
  let taskId: string;

  it('成功：任务落库带 agent 来源五列，会话/流水/审计各一行，task.created 事件发出', async () => {
    const skill = await h.skills.create(
      skillCreateSchema.parse({ name: '单元测试', type: 'prompt', description: '', tags: [], mcp_dependencies: [] }),
    );
    const before = h.emitted.filter((e) => e.event === 'task.created').length;

    const result = (await call('board.create_task', {
      ...baseInput,
      skills: [skill.id, '单元测试', '查无此技能'],
      confirmation_mode: 'direct',
    })) as {
      created: boolean;
      task_id: string;
      session_id: string;
      agent_name: string;
      confirmation_mode: string;
      skill_resolution: { unresolved: string[] };
    };
    taskId = result.task_id;
    expect(result).toMatchObject({
      created: true,
      session_id: baseInput.session_id,
      agent_name: 'qoder-1',
      confirmation_mode: 'direct',
    });
    // §7.5 同口径：id 直通、name 解析、坏引用丢弃不阻断（回显告警）。
    expect(result.skill_resolution.unresolved).toEqual(['查无此技能']);

    const tasks = await h.prisma.$queryRawUnsafe<Record<string, unknown>[]>(
      `SELECT group_id, status, priority, tags, skills, origin_type, origin_agent, origin_session_id, confirmation_mode
         FROM tasks WHERE id = ?`,
      taskId,
    );
    const task = tasks[0]!;
    expect(task).toMatchObject({
      group_id: 'grp_default', // 未指定分组落默认组（§5.2，与 REST 同兜底）
      status: 'BACKLOG',
      priority: 1,
      origin_type: 'agent',
      origin_agent: 'qoder-1',
      origin_session_id: baseInput.session_id,
      confirmation_mode: 'direct',
    });
    const bindings = JSON.parse(task.skills as string) as { skill_id: string; version: string }[];
    // id 与解析到同一技能的 name 去重成一枚；存储形状与 REST 一致（{skill_id, version}）。
    expect(bindings.map((b) => b.skill_id)).toEqual([skill.id]);
    expect(bindings.every((b) => b.version === 'v0.1.0')).toBe(true); // 与 REST 同存储形状（带版本）

    const sessions = await h.prisma.$queryRawUnsafe<{ task_count: number }[]>(
      `SELECT task_count FROM agent_sessions WHERE session_id = ?`,
      baseInput.session_id,
    );
    expect(sessions).toHaveLength(1);
    expect(sessions[0]!.task_count).toBe(1); // 首见建会话即计 1（upsert 的 INSERT 分支）
    expect(await countOf('task_creation_logs', 'WHERE task_id = ?', [taskId])).toBe(1);
    expect(await countOf('audit_logs', "WHERE action = 'task_create' AND target_id = ?", [taskId])).toBe(1);
    const log = await h.prisma.$queryRawUnsafe<Record<string, unknown>[]>(
      `SELECT source, confirmation, user_action, agent_name, session_id FROM task_creation_logs WHERE task_id = ?`,
      taskId,
    );
    expect(log[0]).toMatchObject({
      source: 'mcp',
      confirmation: 'direct',
      user_action: 'created',
      agent_name: 'qoder-1',
      session_id: baseInput.session_id,
    });
    const createdEvents = h.emitted.filter((e) => e.event === 'task.created');
    expect(createdEvents.length).toBe(before + 1);
    // §8.6（W8-a4）：载荷带 origin_type，作为前端 5 秒撤销入口的观察通道。
    expect(createdEvents.at(-1)!.data).toMatchObject({ id: taskId, origin_type: 'agent' });
  });

  it('内置默认技能（§9.6 无版本历史）在 Agent 直建路径同样可绑：按名称解析、版本补 builtin', async () => {
    // 这条链路曾按「必须有 skill_versions 行」校验，随包 125 条内置技能首装即全部 422；
    // 写侧判据改回与下发侧 resolveForTask 同源之后，REST 面由 default-skills.test.ts 钉，
    // Agent 面（`board.create_task` → 同一个 normalizeTaskBindings）在这里钉。
    await ensureDefaultSkills(h.prisma);
    const seed = DEFAULT_SKILL_SEEDS[0]!; // code-review：预置只写 skills 行，不建版本快照
    expect(await h.prisma.skillVersion.count({ where: { skillId: seed.id } })).toBe(0);

    const result = (await call('board.create_task', {
      ...baseInput,
      title: '为支付回调接口补幂等键', // 换标题：撞上一条用例的标题会升级轻确认（§8.2 重复检测）
      session_id: 'conv-builtin-skill', // 换会话：baseInput 的会话计数由 silent 那条独占断言
      skills: [seed.name, '查无此技能'],
      confirmation_mode: 'direct',
    })) as { task_id: string; skill_resolution: { unresolved: string[] } };

    const rows = await h.prisma.$queryRawUnsafe<{ skills: string }[]>(
      `SELECT skills FROM tasks WHERE id = ?`,
      result.task_id,
    );
    expect(JSON.parse(rows[0]!.skills)).toEqual([{ skill_id: seed.id, version: DEFAULT_SKILL_VERSION }]);
    expect(result.skill_resolution.unresolved).toEqual(['查无此技能']);
  });

  it('Agent 直建面吃全局默认键 `default_review_mode`（2026-09-28 拍板「三条建单路一处口径」）', async () => {
    // 这条继承的意义：Agent 面**没有** review_mode 入参位（Q4 执行者不得自豁免），
    // 所以免审核直通只能由人在设置页决定——全局键必须管到这一条路，否则设了也没用。
    // （2026-10-09 裁定移除 auto 后这一键只剩 human/none 两值，清单 §14 判据②；这里取 none。）
    await h.settings.patch({ default_review_mode: 'none' });
    try {
      const result = (await call('board.create_task', {
        ...baseInput,
        title: '为导出接口加分页游标',
        session_id: 'conv-review-mode-default',
        confirmation_mode: 'direct',
      })) as { task_id: string };
      const row = await h.prisma.task.findUnique({ where: { id: result.task_id } });
      expect(row?.reviewMode).toBe('none');
    } finally {
      await h.settings.patch({ default_review_mode: 'human' });
    }
    // 复位后新建的单回到 human——缓存失效路径也在这条用例里（settings 读走内存缓存）。
    const after = (await call('board.create_task', {
      ...baseInput,
      title: '为导出接口补单测',
      session_id: 'conv-review-mode-reset',
      confirmation_mode: 'direct',
    })) as { task_id: string };
    expect((await h.prisma.task.findUnique({ where: { id: after.task_id } }))?.reviewMode).toBe('human');
  });
});

describe('board.create_task 静默创建（silent）+ 会话刷新', () => {
  it('同会话再创建：agent_sessions 仍一行、task_count 递增、流水各记一条', async () => {
    const result = (await call('board.create_task', {
      title: '补充登录回归用例',
      type: '缺陷',
      session_id: 'conv-20260920-001',
      agent_name: 'qoder-1',
      confirmation_mode: 'silent',
    })) as { task_id: string };

    const sessions = await h.prisma.$queryRawUnsafe<{ task_count: number; last_active_at: string }[]>(
      `SELECT task_count, last_active_at FROM agent_sessions WHERE session_id = 'conv-20260920-001'`,
    );
    expect(sessions).toHaveLength(1);
    expect(sessions[0]!.task_count).toBe(2); // §8.7：每次创建刷新 last_active_at/task_count
    expect(sessions[0]!.last_active_at).toBeTruthy();
    expect(await countOf('task_creation_logs', 'WHERE session_id = ?', ['conv-20260920-001'])).toBe(2);
    expect(await countOf('tasks', 'WHERE origin_session_id = ?', ['conv-20260920-001'])).toBe(2);
    const task = await h.prisma.$queryRawUnsafe<{ confirmation_mode: string }[]>(
      `SELECT confirmation_mode FROM tasks WHERE id = ?`,
      result.task_id,
    );
    expect(task[0]!.confirmation_mode).toBe('silent');
  });

  it('agent_name 缺省取凭证名（同 begin_breakdown 口径）', async () => {
    const result = (await call('board.create_task', {
      title: '无署名创建',
      type: '缺陷',
      session_id: 'conv-unsigned',
      confirmation_mode: 'direct',
    })) as { agent_name: string };
    expect(result.agent_name).toBe('qoder-w8');
    const rows = await h.prisma.$queryRawUnsafe<{ agent_name: string }[]>(
      `SELECT agent_name FROM agent_sessions WHERE session_id = 'conv-unsigned'`,
    );
    expect(rows[0]!.agent_name).toBe('qoder-w8');
  });
});

// ---------------------------------------------------------------- 3. light 轻确认决策闭环（§8.7 r3）

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
const unique = (label: string) => `${label} ${Math.random().toString(36).slice(2, 8)}`;

/** 抓取本轮新发的 WS 事件（轻确认卡片下发的实证）。 */
async function nextWsEvent(name: string, since: number) {
  for (let i = 0; i < 200; i++) {
    const hit = h.emitted.slice(since).find((e) => e.event === name);
    if (hit) return hit;
    await sleep(25);
  }
  throw new Error(`未观察到 WS 事件 ${name}`);
}

function requestedCount(): number {
  return h.emitted.filter((e) => e.event === 'agent.task_requested').length;
}

async function settle(id: string, action: 'create' | 'edit' | 'cancel', payload?: Record<string, unknown>) {
  return h.creation.decide(id, { action, payload } as never);
}

describe('board.create_task light 轻确认决策闭环', () => {
  it('确认：wait:false 即时返回 request_id 并下发 WS 卡片；decision=create 落库，轮询/等待工具收口', async () => {
    const before = requestedCount();
    const pending = (await call('board.create_task', {
      ...baseInput,
      title: unique('轻确认-确认'),
      session_id: 'conv-light-ok',
      confirmation_mode: 'light',
      wait: false,
    })) as { created: boolean; pending?: boolean; request_id: string; expires_at: string };
    expect(pending).toMatchObject({ created: false, pending: true, confirmation_mode: 'light' });
    expect(pending.expires_at).toBeTruthy();
    expect(requestedCount()).toBe(before + 1);
    // notification.created（§13.9 待处理通知）会紧跟卡片事件入列，倒序找最近一张卡片。
    const card = [...h.emitted].reverse().find((e) => e.event === 'agent.task_requested')!;
    expect(card.data).toMatchObject({
      request_id: pending.request_id,
      status: 'pending',
      session_id: 'conv-light-ok',
      agent_name: 'qoder-1',
    });

    const view = h.creation.status(pending.request_id);
    expect(view.status).toBe('pending');
    expect(view.decision_deadline_at).toBeTruthy();

    const decided = await settle(pending.request_id, 'create');
    expect(decided.status).toBe('created');
    expect(decided.task_id).toBeTruthy();

    const task = await h.prisma.$queryRawUnsafe<Record<string, unknown>[]>(
      `SELECT confirmation_mode, origin_type FROM tasks WHERE id = ?`,
      decided.task_id,
    );
    expect(task[0]).toMatchObject({ confirmation_mode: 'light', origin_type: 'agent' });
    const log = await h.prisma.$queryRawUnsafe<Record<string, unknown>[]>(
      `SELECT confirmation, user_action, source FROM task_creation_logs WHERE task_id = ?`,
      decided.task_id,
    );
    expect(log[0]).toMatchObject({ confirmation: 'light', user_action: 'created', source: 'mcp' });
    const sessions = await h.prisma.$queryRawUnsafe<{ task_count: number }[]>(
      `SELECT task_count FROM agent_sessions WHERE session_id = 'conv-light-ok'`,
    );
    expect(sessions[0]!.task_count).toBe(1); // 会话记账只发生在真正建成任务时

    // §8.7 r3：board.get_creation_status 轮询与 board.wait_for_confirmation 都回同一终结态。
    const status = (await call('board.get_creation_status', { request_id: pending.request_id })) as {
      status: string;
      task_id: string;
    };
    expect(status).toMatchObject({ status: 'created', task_id: decided.task_id });
    const waited = (await call('board.wait_for_confirmation', { request_id: pending.request_id })) as {
      status: string;
    };
    expect(waited.status).toBe('created');
    await expect(call('board.get_creation_status', { request_id: 'req_missing' })).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });
  });

  it('同步等待：create_task 阻塞到决策；decision=cancel → 不创建、流水记 cancelled（task_id 挂请求 id）', async () => {
    const callPromise = call('board.create_task', {
      ...baseInput,
      title: unique('轻确认-取消'),
      session_id: 'conv-light-cancel',
      confirmation_mode: 'light',
    });
    const since = h.emitted.length;
    const card = await nextWsEvent('agent.task_requested', since);
    const requestId = card.data.request_id as string;
    const decided = await settle(requestId, 'cancel');
    expect(decided.status).toBe('cancelled');

    await expect(callPromise).resolves.toMatchObject({
      created: false,
      status: 'cancelled',
      request_id: requestId,
      confirmation_mode: 'light',
      session_id: 'conv-light-cancel',
    });
    expect(await countOf('tasks', 'WHERE origin_session_id = ?', ['conv-light-cancel'])).toBe(0);
    expect(await countOf('agent_sessions', 'WHERE session_id = ?', ['conv-light-cancel'])).toBe(0);
    const log = await h.prisma.$queryRawUnsafe<Record<string, unknown>[]>(
      `SELECT confirmation, user_action, session_id FROM task_creation_logs WHERE task_id = ?`,
      requestId,
    );
    expect(log[0]).toMatchObject({ confirmation: 'light', user_action: 'cancelled', session_id: 'conv-light-cancel' });
    // 终结后再决策 → 409 CREATION_REQUEST_RESOLVED（§8.7 一请求一归宿）。
    await expect(settle(requestId, 'create')).rejects.toMatchObject({
      code: 'CREATION_REQUEST_RESOLVED',
      status: 409,
    });
  });

  it('编辑确认：edit 带修改后载荷落库（user_action=edited），空载荷 422、未知请求 404', async () => {
    const callPromise = call('board.create_task', {
      ...baseInput,
      title: unique('轻确认-编辑前'),
      session_id: 'conv-light-edit',
      confirmation_mode: 'light',
    });
    const since = h.emitted.length;
    const card = await nextWsEvent('agent.task_requested', since);
    const requestId = card.data.request_id as string;
    await expect(settle(requestId, 'edit')).rejects.toMatchObject({ code: 'VALIDATION_FAILED' }); // edit 缺载荷
    await expect(h.creation.decide('req_missing', { action: 'cancel' })).rejects.toMatchObject({ code: 'NOT_FOUND' });
    await settle(requestId, 'edit', { title: '轻确认-编辑后已改名', priority: 2 });
    const result = (await callPromise) as { created: boolean; task_id: string };
    expect(result).toMatchObject({ created: true, request_id: requestId });
    const task = await h.prisma.$queryRawUnsafe<{ title: string; priority: number }[]>(
      `SELECT title, priority FROM tasks WHERE id = ?`,
      result.task_id,
    );
    expect(task[0]).toMatchObject({ title: '轻确认-编辑后已改名', priority: 2 });
    const log = await h.prisma.$queryRawUnsafe<{ user_action: string }[]>(
      `SELECT user_action FROM task_creation_logs WHERE task_id = ?`,
      result.task_id,
    );
    expect(log[0]!.user_action).toBe('edited');
  });

  it('超时与宽限（§8.7 r3：30s+5s，超时→不创建）：宽限内决策仍有效；到期记 timeout', async () => {
    await h.settings.patch({ light_confirm_timeout_seconds: 1 });
    try {
      // 宽限：expiresAt 之后、deadlineAt 之前决策 → 按创建收口。
      const gracePromise = call('board.create_task', {
        ...baseInput,
        title: unique('轻确认-宽限'),
        session_id: 'conv-light-grace',
        confirmation_mode: 'light',
      });
      const since = h.emitted.length;
      const card = await nextWsEvent('agent.task_requested', since);
      await sleep(1_200); // 已过 1s 超时点、未过 +5s 宽限终点
      await settle(card.data.request_id as string, 'create');
      const graceResult = (await gracePromise) as { created: boolean; status?: string };
      expect(graceResult).toMatchObject({ created: true });

      // 超时：无人决策 → 阻塞方最长等 1s+5s 后拿到「超时→不创建」。
      const timedOut = (await call('board.create_task', {
        ...baseInput,
        title: unique('轻确认-超时'),
        session_id: 'conv-light-timeout',
        confirmation_mode: 'light',
      })) as { created: boolean; status: string; request_id: string };
      expect(timedOut).toMatchObject({ created: false, status: 'timeout', confirmation_mode: 'light' });
      expect(await countOf('tasks', 'WHERE origin_session_id = ?', ['conv-light-timeout'])).toBe(0);
      const log = await h.prisma.$queryRawUnsafe<{ user_action: string }[]>(
        `SELECT user_action FROM task_creation_logs WHERE task_id = ?`,
        timedOut.request_id,
      );
      expect(log[0]!.user_action).toBe('timeout');
      await expect(call('board.wait_for_confirmation', { request_id: timedOut.request_id })).resolves.toMatchObject({
        status: 'timeout',
      });
    } finally {
      await h.settings.patch({ light_confirm_timeout_seconds: 30 });
    }
  }, 20_000);

  it('模式优先级（§8.2）：参数 > 设置 agent_creation_mode > 默认轻确认；direct 重复命中升级轻确认卡片', async () => {
    // 设置成 silent：不传参数的调用即时创建（参数缺省时设置生效）。
    await h.settings.patch({ agent_creation_mode: 'silent' });
    const silent = (await call('board.create_task', {
      title: unique('轻确认-设置silent'),
      type: '缺陷',
      session_id: 'conv-mode-silent',
      agent_name: 'qoder-1',
    })) as { created: boolean; confirmation_mode: string };
    expect(silent).toMatchObject({ created: true, confirmation_mode: 'silent' });
    await h.settings.patch({ agent_creation_mode: 'light' });

    // 缺省 → 轻确认（异步形态即时返回 request_id）。
    const light = (await call('board.create_task', {
      title: unique('轻确认-默认light'),
      type: '缺陷',
      session_id: 'conv-mode-light',
      agent_name: 'qoder-1',
      wait: false,
    })) as { pending?: boolean; confirmation_mode: string; request_id: string };
    expect(light).toMatchObject({ pending: true, confirmation_mode: 'light' });
    await settle(light.request_id, 'cancel'); // 清理待决，避免超时尾巴

    // §8.2：direct 重复检测命中（同组 5 分钟内同标题 Jaccard>0.8）→ 升级为轻确认卡片。
    const dupTitle = unique('轻确认-重复升级');
    const first = (await call('board.create_task', {
      title: dupTitle,
      type: '缺陷',
      session_id: 'conv-dup-a',
      agent_name: 'qoder-1',
      confirmation_mode: 'direct',
    })) as { created: boolean };
    expect(first.created).toBe(true);
    const escalated = (await call('board.create_task', {
      title: dupTitle, // 一字不改再来一次
      type: '缺陷',
      session_id: 'conv-dup-b',
      agent_name: 'qoder-1',
      confirmation_mode: 'direct',
      wait: false,
    })) as { pending?: boolean; confirmation_mode: string; request_id: string };
    expect(escalated).toMatchObject({ pending: true, confirmation_mode: 'light' });
    expect(escalated.request_id).toBeTruthy();
    const dupView = h.creation.status(escalated.request_id);
    expect(dupView.duplicates.length).toBeGreaterThan(0); // §8.5 卡片顶部疑似重复链接
    await expect(countOf('tasks', 'WHERE origin_session_id = ?', ['conv-dup-b'])).resolves.toBe(0);
    await settle(escalated.request_id, 'cancel');
  });
});

describe('board.create_task 校验与鉴权', () => {
  it('UI 凭证调用 → FORBIDDEN（Agent 凭证专属）', async () => {
    await expect(call('board.create_task', baseInput, ui)).rejects.toMatchObject({ code: 'FORBIDDEN' });
  });

  it('类型不在词表 / 需求走拆解 / 未知分组 / 空标题各归各错', async () => {
    await expect(
      call('board.create_task', { ...baseInput, type: '太空类型', confirmation_mode: 'direct' }),
    ).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
    await expect(
      call('board.create_task', { ...baseInput, type: '需求', confirmation_mode: 'direct' }),
    ).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
    await expect(
      call('board.create_task', { ...baseInput, group_id: 'grp_missing', confirmation_mode: 'direct' }),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
    await expect(
      call('board.create_task', { ...baseInput, title: '  ', confirmation_mode: 'direct' }),
    ).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
  });
});

// ---------------------------------------------------------------- W8-a3：§13.9 通知 / §8.7 批量 / §8.6 撤销

describe('§13.9 creation_request 站内通知', () => {
  it('silent 创建成功 → 带 task_id 的 creation_request 通知一条 + notification.created WS 事件', async () => {
    const before = h.emitted.filter((e) => e.event === 'notification.created').length;
    const result = (await call('board.create_task', {
      title: '静默通知探针任务',
      type: '缺陷',
      session_id: 'conv-notif-1',
      agent_name: 'qoder-1',
      confirmation_mode: 'silent',
    })) as { task_id: string };
    const rows = await h.prisma.$queryRawUnsafe<Record<string, unknown>[]>(
      `SELECT kind, task_id, message FROM notifications WHERE kind = 'creation_request' AND task_id = ?`,
      result.task_id,
    );
    expect(rows).toHaveLength(1);
    expect(String(rows[0]!.message)).toContain('已创建任务');
    expect(h.emitted.filter((e) => e.event === 'notification.created').length).toBeGreaterThan(before);
  });

  it('light 待决请求 → 挂空 task_id 的 creation_request 通知（§13.9 待处理区数据源）', async () => {
    const pending = (await call('board.create_task', {
      title: '轻确认通知探针',
      type: '缺陷',
      session_id: 'conv-notif-2',
      agent_name: 'qoder-1',
      confirmation_mode: 'light',
      wait: false,
    })) as { request_id: string };
    const rows = await h.prisma.$queryRawUnsafe<Record<string, unknown>[]>(
      `SELECT task_id, message FROM notifications WHERE kind = 'creation_request' AND message LIKE ?`,
      '%轻确认通知探针%',
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]!.task_id).toBeNull();
    expect(String(rows[0]!.message)).toContain('请求创建任务');
    await settle(pending.request_id, 'cancel');
  });
});

describe('board.create_tasks_batch（§8.7 批量·轻量版）', () => {
  it('UI 凭证调用 → FORBIDDEN（Agent 凭证专属）', async () => {
    await expect(
      call('board.create_tasks_batch', { tasks: [{ title: 'x', type: '缺陷' }], session_id: 'conv-b0' }, ui),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
  });

  it('direct 三条含一条坏类型：逐条结果对位、坏条目不熔断、会话计数与通知逐条就位', async () => {
    const res = (await call('board.create_tasks_batch', {
      tasks: [{ title: '走查登录页样式', type: '缺陷' }, { title: '批量坏条目', type: '太空类型' }, { title: '补导出接口说明', type: '子任务' }],
      session_id: 'conv-batch-1',
      agent_name: 'qoder-1',
      confirmation_mode: 'direct',
    })) as { results: unknown[]; task_ids: string[]; request_ids: string[] };
    expect(res.results).toHaveLength(3);
    expect(res.task_ids).toHaveLength(2);
    expect(res.request_ids).toEqual([]);
    expect(res.results[1]).toMatchObject({ index: 1, created: false, error: { code: 'VALIDATION_FAILED' } });
    const sessions = await h.prisma.$queryRawUnsafe<{ task_count: number }[]>(
      `SELECT task_count FROM agent_sessions WHERE session_id = 'conv-batch-1'`,
    );
    expect(sessions).toHaveLength(1);
    expect(sessions[0]!.task_count).toBe(2); // 只给真正建成的条目记账
    expect(
      await countOf('notifications', "WHERE kind = 'creation_request' AND task_id IN (?, ?)", res.task_ids),
    ).toBe(2); // §13.9：direct/silent 成功逐条通知
  });

  it('light 条目缺省不阻塞：即时返回 request_id，get_creation_status 可查待决', async () => {
    const res = (await call('board.create_tasks_batch', {
      tasks: [{ title: '批量轻确认甲', type: '缺陷' }],
      session_id: 'conv-batch-2',
      agent_name: 'qoder-1',
      confirmation_mode: 'light',
    })) as { request_ids: string[] };
    expect(res.request_ids).toHaveLength(1);
    const view = h.creation.status(res.request_ids[0]!);
    expect(view).toMatchObject({ status: 'pending', title: '批量轻确认甲', source: 'mcp' });
    await settle(res.request_ids[0]!, 'cancel');
  });
});

describe('§8.6 撤销守卫（DELETE /tasks/{id} 的撤销记账）', () => {
  const tasksService = () =>
    new TasksService(
      h.prisma,
      h.settings,
      new AuditService(h.prisma),
      h.events,
      new NotificationsService(h.prisma, h.events),
      { cleanupTaskDir: () => {} } as unknown as ArtifactsService,
      h.skills,
      { error: () => {} } as unknown as AppLogger,
    );

  it('agent 直建且未领取：UI 凭证删除成功并补记 cancelled 流水（undone:true）', async () => {
    const created = (await call('board.create_task', {
      title: '撤销探针任务',
      type: '缺陷',
      session_id: 'conv-undo',
      agent_name: 'qoder-1',
      confirmation_mode: 'direct',
    })) as { task_id: string };
    const res = await tasksService().remove(created.task_id);
    expect(res.undone).toBe(true);
    expect(await countOf('tasks', 'WHERE id = ?', [created.task_id])).toBe(0);
    const logs = await h.prisma.$queryRawUnsafe<Record<string, unknown>[]>(
      `SELECT source, confirmation, user_action, agent_name, session_id FROM task_creation_logs WHERE task_id = ? ORDER BY id`,
      created.task_id,
    );
    expect(logs).toHaveLength(2); // 创建一条 + 撤销一条（task_id 无外键，物理删后仍可读）
    expect(logs[0]).toMatchObject({ source: 'mcp', user_action: 'created' });
    expect(logs[1]).toMatchObject({
      source: 'ui',
      confirmation: 'direct',
      user_action: 'cancelled',
      agent_name: 'qoder-1',
      session_id: 'conv-undo',
    });
  });

  it('非 agent 来源 / 已领取的 agent 任务：沿用现行规则，不记 cancelled 流水', async () => {
    await h.prisma.$executeRawUnsafe(`INSERT INTO tasks (id, type, title) VALUES ('undo_manual', '缺陷', '手工任务')`);
    expect((await tasksService().remove('undo_manual')).undone).toBe(false);

    const created = (await call('board.create_task', {
      title: '已领取探针任务',
      type: '缺陷',
      session_id: 'conv-undo2',
      agent_name: 'qoder-1',
      confirmation_mode: 'silent',
    })) as { task_id: string };
    await h.prisma.task.update({
      where: { id: created.task_id },
      data: { claimedAt: '2026-09-20 00:00:00', leaseId: 'lease-undo' },
    });
    expect((await tasksService().remove(created.task_id)).undone).toBe(false);
    expect(
      await countOf('task_creation_logs', "WHERE task_id = ? AND user_action = 'cancelled'", [created.task_id]),
    ).toBe(0);
  });
});
