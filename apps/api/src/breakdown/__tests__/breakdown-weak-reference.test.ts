import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { cpSync, mkdirSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { applyMigrations, collectMigrations, migrationsDir } from '../../infra/bootstrap';
import { createTestApp, type Sender, type TestApp } from '../../__tests__/helpers/http-app';
import { API, uiSender } from '../../__tests__/helpers/seed';
import { BreakdownService, type BreakdownDraftInput } from '../breakdown.service';

/**
 * 0022：拆解会话对 `tasks` / `groups` 是**弱引用**（DDL 侧 `ON DELETE SET NULL`）。
 *
 * 缺陷口径（用户反馈「删除卡片任务报本地服务内部错误」）：删掉一张由需求拆解产出的父需求
 * 卡片 → `500 {code:'INTERNAL'}` → 界面文案「本地服务内部错误」。根因不在删除逻辑，在 DDL：
 * 0012 把 §7.6 的 `group_id` / `parent_task_id` 写成裸 `REFERENCES`（SQLite 缺省 NO ACTION，
 * 约束生效但不带任何级联动作），而 `tasks.service.remove()` 是物理删——FK 违规被 Prisma 抛成
 * 非 ApiException，异常过滤器只能兜到 500。删分组（`DELETE /groups/:id`）中同一条 FK。
 *
 * 三条口径都要钉住，少一条就退回原缺陷或换一种丢数据的方式：
 *   1. 删除必须成功（不能把 FK 违规洗成另一种 5xx 或含糊的 4xx）；
 *   2. 拆解会话是历史页的账本，**不跟着任务/分组一起销毁**（所以不能改成 CASCADE）；
 *   3. 指针归 NULL 而非留悬空 id（所以不能学 0013 干脆不建外键：读面会拿到打不开的短号）。
 */
let t: TestApp;
let svc: BreakdownService;
let ui: Sender;

beforeAll(async () => {
  t = await createTestApp();
  svc = t.app.get(BreakdownService);
  ui = uiSender(t);
}, 60_000);

afterAll(async () => {
  await t?.close();
});

const suffix = () => Math.random().toString(36).slice(2, 8);

/** 走真实确认链：begin → 两条草案 → finish → UI confirm（父需求 + 两子任务落库）。 */
async function confirmedBreakdown(groupId?: string) {
  const title = `弱引用会话 ${suffix()}`;
  const session = await svc.begin({
    requirement_text: `${title} 的需求原文`,
    parent_title: title,
    ...(groupId ? { group_id: groupId } : {}),
  });
  const drafts: BreakdownDraftInput[] = [
    { ref: 'd1', title: `${title} · 数据模型` },
    { ref: 'd2', title: `${title} · 接口` },
  ];
  for (const draft of drafts) await svc.reportDraft(session.id, draft);
  await svc.finish(session.id);
  const res = await ui.post(`${API}/breakdown/sessions/${session.id}/confirm`);
  expect(res.status).toBe(201);
  return {
    sessionId: session.id,
    parentId: res.body.parent_task_id as string,
    childIds: res.body.task_ids as string[],
  };
}

async function newGroup(name: string): Promise<string> {
  const res = await ui.post(`${API}/groups`, { name });
  expect(res.status).toBe(201);
  return res.body.id as string;
}

/**
 * `PRAGMA foreign_key_list` 里按被引用表取 onDelete 动作。
 * 列名是 SQLite 的原样 `on_delete`：PRAGMA 结果不走 Prisma 的 `@map` 转换，
 * 写成 `onDelete` 只会拿到 undefined（形状探针实测过一条行：
 * `{table:'tasks', from:'parent_task_id', on_delete:'SET NULL'}`）。
 */
async function onDeleteAction(table: string, refTable: string): Promise<string | undefined> {
  const rows = await t.prisma.$queryRawUnsafe<{ table: string; on_delete: string }[]>(
    `PRAGMA foreign_key_list(${table})`,
  );
  return rows.find((row) => row.table === refTable)?.on_delete;
}

async function sessionPointers(sessionId: string) {
  const rows = await t.prisma.$queryRawUnsafe<{ group_id: string | null; parent_task_id: string | null }[]>(
    `SELECT group_id, parent_task_id FROM breakdown_sessions WHERE id = ?`,
    sessionId,
  );
  return rows[0];
}

describe('DDL 形状闸（0022）', () => {
  it('breakdown_sessions 对 tasks / groups 的两条外键动作都是 SET NULL', async () => {
    // 防回退：0022 被改回裸 REFERENCES、或新库全量重放漂移，这里先红。
    expect(await onDeleteAction('breakdown_sessions', 'tasks')).toBe('SET NULL');
    expect(await onDeleteAction('breakdown_sessions', 'groups')).toBe('SET NULL');
  });

  it('子表对 breakdown_sessions 仍是 CASCADE（0022 整表重建不得丢掉草案/进度链）', async () => {
    expect(await onDeleteAction('breakdown_drafts', 'breakdown_sessions')).toBe('CASCADE');
    expect(await onDeleteAction('breakdown_progress', 'breakdown_sessions')).toBe('CASCADE');
  });
});

describe('DELETE /api/v1/tasks/{id}：删拆解产出的父需求', () => {
  it('子任务先删、父需求随后删除成功（原缺陷在这里回 500 本地服务内部错误）', async () => {
    const { sessionId, parentId, childIds } = await confirmedBreakdown();

    for (const childId of childIds) {
      expect((await ui.del(`${API}/tasks/${childId}`)).status).toBe(200);
    }
    const del = await ui.del(`${API}/tasks/${parentId}`);
    expect(del.status).toBe(200);
    expect(del.body).toMatchObject({ id: parentId });

    // 会话与两条草案留在库里，父任务指针归空（悬空 id 会让历史页显示打不开的短号）。
    expect((await sessionPointers(sessionId))?.parent_task_id).toBeNull();
    const kept = await t.prisma.$queryRawUnsafe<{ count: number }[]>(
      `SELECT COUNT(*) AS count FROM breakdown_drafts WHERE session_id = ?`,
      sessionId,
    );
    expect(Number(kept[0]?.count ?? 0)).toBe(2);
    const gone = await t.prisma.$queryRawUnsafe<{ count: number }[]>(
      `SELECT COUNT(*) AS count FROM tasks WHERE id = ?`,
      parentId,
    );
    expect(Number(gone[0]?.count ?? 1)).toBe(0);
  });

  it('会话读面在父任务消失后仍 200，parent_task_id 回 null', async () => {
    const { sessionId, parentId, childIds } = await confirmedBreakdown();
    for (const childId of childIds) expect((await ui.del(`${API}/tasks/${childId}`)).status).toBe(200);
    expect((await ui.del(`${API}/tasks/${parentId}`)).status).toBe(200);

    const res = await ui.get(`${API}/breakdown/sessions/${sessionId}`);
    expect(res.status).toBe(200);
    expect(res.body.session).toMatchObject({
      id: sessionId,
      status: 'completed',
      parent_task_id: null,
    });
  });
});

// ---------------------------------------------------------------- 升级路径演练
// 上面全部用例走的是 fresh 全量重放（0022 随链一次落地）。真用户库不是这样：
// 它的水位已经停在 0021，库里躺着带指针的拆解会话，0022 是**在存量行上整表重建**。
// 这条演练钉的是「升级不丢历史 + 升级后动作真的翻了」——只看 fresh 就等于没验升级路径。
describe('水位 0021 的既有库只重放 0022：存量会话零丢失、外键动作真的翻了', () => {
  it('升级前后逐列比对，且删掉被引用的需求后会话留下、指针归空', () => {
    const root = mkdtempSync(path.join(tmpdir(), 'atb-0022-upgrade-'));
    const previous = {
      data: process.env.ATB_DATA_DIR,
      mig: process.env.ATB_MIGRATIONS_DIR,
      logs: process.env.ATB_LOGS_DIR,
    };
    const orders = (count: number) => Array.from({ length: count }, (_, index) => index + 1);
    // 顶从迁移目录现取：下一棒再加迁移时，本用例的「只重放 0022」口径仍成立（0012 之前定稿不动）。
    const top = Math.max(...collectMigrations().map((migration) => migration.order));
    const dirOf = (name: string): string => {
      const dir = path.join(root, name);
      mkdirSync(dir, { recursive: true });
      return dir;
    };
    /** 按被引用表取 onDelete 动作（PRAGMA 结果不走 Prisma 的 camelCase 转换）。 */
    const actions = (db: DatabaseSync): Record<string, string> => {
      const rows = db.prepare('PRAGMA foreign_key_list(breakdown_sessions)').all() as
        { table: string; on_delete: unknown }[];
      const out: Record<string, string> = {};
      for (const row of rows) out[row.table] = String(row.on_delete);
      return out;
    };
    // 整行取回，用于升级前后逐列比对（BigInt 列不参与，本表全是 TEXT）。
    const dump = (db: DatabaseSync) => ({
      sessions: db
        .prepare(
          `SELECT id, requirement_text, group_id, parent_title, parent_description, parent_task_id,
                  status, agent_name, skill_used, estimated_tasks, actual_tasks,
                  created_at, finished_at, confirmed_at, cancelled_at
           FROM breakdown_sessions ORDER BY id`,
        )
        .all(),
      drafts: db
        .prepare(`SELECT id, session_id, ref, title, description, priority, sort_order
                  FROM breakdown_drafts ORDER BY id`)
        .all(),
      progress: db.prepare(`SELECT session_id, step, total, message FROM breakdown_progress ORDER BY id`).all(),
    });

    try {
      process.env.ATB_LOGS_DIR = path.join(root, 'logs');
      mkdirSync(process.env.ATB_LOGS_DIR, { recursive: true });

      // 1) 用 ≤0021 的迁移子集造「升级前的库」，塞进两条会话（一带指针一全空）+ 草案 + 进度流水。
      const source = migrationsDir();
      const staged = path.join(root, 'migrations-0021');
      mkdirSync(staged);
      for (const entry of readdirSync(source)) {
        if (/^\d+_/.test(entry) && Number(entry.split('_')[0]) <= 21) {
          cpSync(path.join(source, entry), path.join(staged, entry), { recursive: true });
        }
      }
      const template = dirOf('template');
      process.env.ATB_DATA_DIR = template;
      process.env.ATB_MIGRATIONS_DIR = staged;
      expect(applyMigrations()).toEqual(orders(21));

      const before = new DatabaseSync(path.join(template, 'jarvis.db'));
      expect(actions(before).tasks).toBe('NO ACTION'); // 裸 REFERENCES：约束生效、零级联动作
      expect(actions(before).groups).toBe('NO ACTION');
      before.exec(`
        INSERT INTO groups (id, name) VALUES ('g_drill', '演练组');
        INSERT INTO tasks (id, title, group_id) VALUES ('t_parent', '演练需求', 'g_drill');
        INSERT INTO tasks (id, title, parent_task_id) VALUES ('t_kid', '演练子任务', 't_parent');
        INSERT INTO breakdown_sessions (id, requirement_text, group_id, parent_title, parent_task_id,
                                        status, agent_name, skill_used, estimated_tasks, actual_tasks,
                                        finished_at, confirmed_at)
        VALUES ('s_ptr', '演练需求原文', 'g_drill', '演练需求', 't_parent',
                'completed', 'qoder-1', 'skl_x', 2, 2,
                '2026-09-01 10:00:00', '2026-09-01 10:05:00'),
               ('s_null', '未落库的会话', NULL, '只填了标题', NULL,
                'cancelled', NULL, NULL, NULL, NULL,
                NULL, NULL);
        INSERT INTO breakdown_drafts (id, session_id, ref, title, description, priority, sort_order)
        VALUES ('d_1', 's_ptr', 'd1', '草稿一', '说明', 1, 0),
               ('d_2', 's_ptr', 'd2', '草稿二', NULL, 3, 1);
        INSERT INTO breakdown_progress (session_id, step, total, message)
        VALUES ('s_ptr', 2, 2, '拆解完成');
      `);
      const snapshot = dump(before);
      expect(snapshot.sessions.map((row) => (row as { id: string }).id)).toEqual(['s_null', 's_ptr']);
      before.close();

      // 2) 切回全量目录：只重放 0022 这一棒（真库的首启形状）。
      const upgraded = dirOf('upgraded');
      cpSync(template, upgraded, { recursive: true });
      process.env.ATB_DATA_DIR = upgraded;
      delete process.env.ATB_MIGRATIONS_DIR;
      expect(applyMigrations()).toEqual(orders(top).filter((order) => order > 21));

      const after = new DatabaseSync(path.join(upgraded, 'jarvis.db'));
      expect(actions(after).tasks).toBe('SET NULL');
      expect(actions(after).groups).toBe('SET NULL');
      // 整表重建的账：逐列比对，历史一行不丢、一列不变（0021 的 task_dependencies 同口径）。
      expect(dump(after)).toEqual(snapshot);
      expect(after.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
      expect(Object.values(after.prepare('PRAGMA integrity_check').get() as Record<string, string>)).toEqual(['ok']);

      // 3) 升级后的库里走真实删除顺序（先子后父，同 tasks.service.remove 的 0919 护栏）：
      //    会话必须活着、parent_task_id 归空，而 group_id 与草案/进度不受影响。
      after.exec('PRAGMA foreign_keys = ON;');
      after.exec(`DELETE FROM tasks WHERE id = 't_kid'; DELETE FROM tasks WHERE id = 't_parent';`);
      expect(after.prepare(`SELECT group_id, parent_task_id FROM breakdown_sessions WHERE id = 's_ptr'`).get())
        .toEqual({ group_id: 'g_drill', parent_task_id: null });
      expect(after.prepare(`SELECT COUNT(*) AS n FROM breakdown_drafts WHERE session_id = 's_ptr'`).get())
        .toMatchObject({ n: 2 });
      expect(after.prepare(`SELECT COUNT(*) AS n FROM breakdown_progress WHERE session_id = 's_ptr'`).get())
        .toMatchObject({ n: 1 });
      after.close();

      // 4) 幂等：二次 applyMigrations() 空转，不重复重建（整表重建跑第二遍会自撞新表名）。
      expect(applyMigrations()).toEqual([]);
    } finally {
      for (const [key, value] of Object.entries({ ATB_DATA_DIR: previous.data, ATB_MIGRATIONS_DIR: previous.mig, ATB_LOGS_DIR: previous.logs })) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('DELETE /api/v1/groups/{id}：删被拆解会话引用的分组', () => {
  it('cascade：组内任务与分组一起删，会话留存且两个指针都归空', async () => {
    const groupId = await newGroup(`弱引用组 ${suffix()}`);
    const { sessionId, childIds } = await confirmedBreakdown(groupId);
    // 0919 护栏「带子任务的任务不可删」会先把 409 挡在前面，这里要的是 FK 那一段。
    for (const childId of childIds) expect((await ui.del(`${API}/tasks/${childId}`)).status).toBe(200);

    const res = await ui.del(`${API}/groups/${groupId}?strategy=cascade`);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ deleted: true, strategy: 'cascade', affected_tasks: 1 });

    const row = await sessionPointers(sessionId);
    expect(row).toMatchObject({ group_id: null, parent_task_id: null });
  });

  it('migrate：任务迁去目标分组，会话 group_id 归空而 parent_task_id 仍有效', async () => {
    const groupId = await newGroup(`迁移组 ${suffix()}`);
    const targetId = await newGroup(`迁入组 ${suffix()}`);
    const { sessionId, parentId } = await confirmedBreakdown(groupId);

    const res = await ui.del(`${API}/groups/${groupId}?strategy=migrate&targetGroupId=${targetId}`);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ deleted: true, strategy: 'migrate', affected_tasks: 3 });

    const row = await sessionPointers(sessionId);
    expect(row).toMatchObject({ group_id: null, parent_task_id: parentId });
    const moved = await t.prisma.$queryRawUnsafe<{ group_id: string }[]>(
      `SELECT group_id FROM tasks WHERE id = ?`,
      parentId,
    );
    expect(moved[0]?.group_id).toBe(targetId);
  });
});
