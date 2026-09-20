import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestApp, errorCode, type TestApp } from '../../__tests__/helpers/http-app';
import { API, newTask, uiSender } from '../../__tests__/helpers/seed';
import { EventsService, type WsEvent } from '../../infra/events.service';
import { GROUP_LIMIT } from '../groups.service';

/**
 * v0.0.4 W1b「Project → Group」术语迁移的落点回归（需求.md §21.1 / §5.5 / §16.2）：
 * - 路径改齐 `/api/v1/groups`，旧路径不提供 deprecated 别名（纯本地单用户）；
 * - 任务归属列改名 `group_id`；
 * - 审计动作/对象改名 `group_change` / `group`；
 * - §5.5 上限 50 为本版新增校验（仅计活跃分组）。
 */
let t: TestApp;
let ui: ReturnType<typeof uiSender>;

beforeAll(async () => {
  t = await createTestApp();
  ui = uiSender(t);
}, 60_000);

afterAll(async () => {
  await t?.close();
});

async function createGroup(name: string, extra: Record<string, unknown> = {}) {
  return ui.post<{ id: string; name: string }>(`${API}/groups`, { name, ...extra });
}

describe('分组 CRUD', () => {
  it('POST /api/v1/groups 建组，列表按 sort 返回', async () => {
    const created = await createGroup('电商平台', { color: '#3B82F6', icon: '📁', sort: 1 });
    expect(created.status).toBe(201);
    expect(created.body.name).toBe('电商平台');

    const list = await ui.get<{ items: { id: string; name: string }[] }>(`${API}/groups`);
    expect(list.status).toBe(200);
    expect(list.body.items.map((item) => item.name)).toContain('电商平台');
  });

  it('PATCH 改名，重名按 duplicate_name 拒绝（§20.1-3 分组名唯一）', async () => {
    const a = await createGroup('支付系统');
    const b = await createGroup('用户中心');
    const renamed = await ui.patch(`${API}/groups/${b.body.id}`, { name: '支付系统' });
    expect(renamed.status).toBe(422);
    expect(errorCode(renamed)).toBe('VALIDATION_FAILED');
    const kept = await ui.patch<{ id: string; name: string }>(`${API}/groups/${a.body.id}`, {
      name: '支付系统 v2',
    });
    expect(kept.status).toBe(200);
    expect(kept.body.name).toBe('支付系统 v2');
  });

  it('旧路径 /api/v1/projects 已随改名移除', async () => {
    const gone = await ui.get(`${API}/projects`);
    expect(gone.status).toBe(404);
  });

  it('创建/编辑/删除都记 group_change 审计，对象类型 group', async () => {
    const created = await createGroup('待删分组');
    const removed = await ui.del(`${API}/groups/${created.body.id}?strategy=cascade`);
    expect(removed.status).toBe(200);
    const rows = await t.prisma.auditLog.findMany({
      where: { action: 'group_change', targetType: 'group', targetId: created.body.id },
    });
    expect(rows.map((row) => row.action)).toEqual(['group_change', 'group_change']);
    expect(rows.every((row) => row.targetType === 'group')).toBe(true);
  });
});

describe('任务归属列 group_id', () => {
  it('建任务带 group_id，详情与卡片都读得到；不存在的分组 404', async () => {
    const group = await createGroup('归属校验组');
    const id = await newTask(t, { title: '带分组任务', group_id: group.body.id });
    const detail = await ui.get<{ group_id: string | null }>(`${API}/tasks/${id}`);
    expect(detail.status).toBe(200);
    expect(detail.body.group_id).toBe(group.body.id);

    const filtered = await ui.get<{ items: { id: string }[] }>(
      `${API}/tasks?group_id=${group.body.id}`,
    );
    expect(filtered.body.items.map((item) => item.id)).toContain(id);

    const orphan = await ui.post(`${API}/tasks`, {
      title: '指向不存在分组',
      type: '需求',
      group_id: 'grp_not_exists',
    });
    expect(orphan.status).toBe(404);
    expect(errorCode(orphan)).toBe('NOT_FOUND');
  });
});

describe('删除分组的两种任务处理（§5.4 / §16.2）', () => {
  it('strategy=migrate 把任务迁去目标分组', async () => {
    const from = await createGroup('迁出组');
    const to = await createGroup('迁入组');
    const id = await newTask(t, { title: '被迁移的任务', group_id: from.body.id });
    const res = await ui.del<{ affected_tasks: number; strategy: string }>(
      `${API}/groups/${from.body.id}?strategy=migrate&targetGroupId=${to.body.id}`,
    );
    expect(res.status).toBe(200);
    expect(res.body.strategy).toBe('migrate');
    expect(res.body.affected_tasks).toBe(1);
    const task = await ui.get<{ group_id: string }>(`${API}/tasks/${id}`);
    expect(task.body.group_id).toBe(to.body.id);
  });

  it('strategy=migrate 缺 targetGroupId → 422；strategy=cascade 连任务一起删', async () => {
    const group = await createGroup('连带删除组');
    await newTask(t, { title: '一起消失', group_id: group.body.id });
    const bad = await ui.del(`${API}/groups/${group.body.id}?strategy=migrate`);
    expect(bad.status).toBe(422);

    const cascade = await ui.del<{ affected_tasks: number }>(
      `${API}/groups/${group.body.id}?strategy=cascade`,
    );
    expect(cascade.status).toBe(200);
    expect(cascade.body.affected_tasks).toBe(1);
    expect(await t.prisma.group.count({ where: { id: group.body.id } })).toBe(0);
  });
});

describe('§5.5 分组数量上限 50', () => {
  it('活跃分组达到上限后 POST 拒绝，错误码 GROUP_LIMIT_REACHED', async () => {
    const active = await t.prisma.group.count({ where: { status: 'ACTIVE' } });
    for (let index = active; index < GROUP_LIMIT; index += 1) {
      const res = await createGroup(`占位分组 ${index}`);
      expect(res.status).toBe(201);
    }
    const rejected = await createGroup('第 51 个分组');
    expect(rejected.status).toBe(409);
    expect(errorCode(rejected)).toBe('GROUP_LIMIT_REACHED');
    expect(await t.prisma.group.count({ where: { status: 'ACTIVE' } })).toBe(GROUP_LIMIT);
  });

  it('归档分组不占额：转 ARCHIVED 后可以再建（§5.5「仅计活跃分组」）', async () => {
    const filler = await t.prisma.group.findFirst({
      where: { name: { startsWith: '占位分组' }, status: 'ACTIVE' },
    });
    expect(filler).not.toBeNull();
    const archived = await ui.patch<{ status: string }>(`${API}/groups/${filler!.id}`, {
      status: 'ARCHIVED',
    });
    expect(archived.body.status).toBe('ARCHIVED');
    const created = await createGroup('腾出名额后的新分组');
    expect(created.status).toBe(201);
  });
});

/**
 * v0.0.4 W1-D1（QA 回归）：预置「默认」分组——需求.md §5.2 / §5.5 删除保护 /
 * 验收条款 7（默认分组不可删除）。存量无归属任务的归位发生在 0009 迁移 SQL 里，
 * 由 /tmp 真库副本演练断言覆盖；这里覆盖运行期行为。
 */
describe('预置「默认」分组（§5.2 / 验收 7）', () => {
  async function defaultRow() {
    const row = await t.prisma.group.findFirst({ where: { isDefault: 1 } });
    expect(row).not.toBeNull();
    return row!;
  }

  it('0009 迁移在库落地固定预置行：is_default=1、名「默认」，且 GET 列表透出 is_default', async () => {
    const row = await defaultRow();
    expect(row.name).toBe('默认');
    const list = await ui.get<{
      items: { id: string; name: string; is_default: number }[];
    }>(`${API}/groups`);
    expect(list.status).toBe(200);
    const dto = list.body.items.find((item) => item.id === row.id);
    expect(dto?.name).toBe('默认');
    expect(dto?.is_default).toBe(1);
    expect(list.body.items.filter((item) => item.is_default === 1)).toHaveLength(1);
  });

  it('默认分组不可删：migrate 与 cascade 两种策略都 409 GROUP_DEFAULT_PROTECTED（§5.5）', async () => {
    const row = await defaultRow();
    // 前面的上限用例已把活跃名额占满，迁移目标复用既有分组而不是再建。
    const other = await t.prisma.group.findFirst({
      where: { id: { not: row.id }, isDefault: 0 },
    });
    expect(other).not.toBeNull();
    for (const query of [
      'strategy=cascade',
      `strategy=migrate&targetGroupId=${other!.id}`,
    ]) {
      const res = await ui.del(`${API}/groups/${row.id}?${query}`);
      expect(res.status).toBe(409);
      expect(errorCode(res)).toBe('GROUP_DEFAULT_PROTECTED');
    }
    expect(await t.prisma.group.count({ where: { id: row.id } })).toBe(1);
  });

  it('默认分组不可归档（§5.6 口径的防御性校验）、is_default 改不动（PATCH 词表里没有它）', async () => {
    const row = await defaultRow();
    const archived = await ui.patch(`${API}/groups/${row.id}`, { status: 'ARCHIVED' });
    expect(archived.status).toBe(409);
    expect(errorCode(archived)).toBe('GROUP_DEFAULT_PROTECTED');

    const flipped = await ui.patch(`${API}/groups/${row.id}`, { is_default: 0 } as never);
    expect(flipped.status).toBe(422);
    expect(errorCode(flipped)).toBe('VALIDATION_FAILED');
    expect((await defaultRow()).isDefault).toBe(1);

    // 普通字段的编辑仍然放行（§5.4 默认分组保留「编辑」入口）。
    const renamed = await ui.patch<{ name: string }>(`${API}/groups/${row.id}`, {
      name: '默认 v2',
    });
    expect(renamed.status).toBe(200);
    await ui.patch(`${API}/groups/${row.id}`, { name: '默认' });
  });

  it('新建任务未指定分组 → 归入默认分组（§5.2）；显式指定仍是显式值', async () => {
    const row = await defaultRow();
    const implicitId = await newTask(t, { title: '没带分组的任务' });
    const implicit = await ui.get<{ group_id: string }>(`${API}/tasks/${implicitId}`);
    expect(implicit.status).toBe(200);
    expect(implicit.body.group_id).toBe(row.id);

    // 前面的上限用例已把活跃名额占满，这里复用既有活跃分组而不是再建。
    const other = await t.prisma.group.findFirst({
      where: { id: { not: row.id }, isDefault: 0, status: 'ACTIVE' },
    });
    expect(other).not.toBeNull();
    const explicitId = await newTask(t, { title: '带分组的任务', group_id: other!.id });
    const detail = await ui.get<{ group_id: string }>(`${API}/tasks/${explicitId}`);
    expect(detail.body.group_id).toBe(other!.id);
  });
});

/**
 * v0.0.4 W4 分组归档（需求.md §5.6 / §16.2 archive/unarchive / §19.12-72、73、78，r3 闭环）。
 * 前置用例已把活跃名额占满，这里先用数据面放倒占位分组腾额度
 * （夹具不是用户操作，不走带校验的归档接口）；随后各用例走真实 HTTP 入口。
 */
describe('§5.6 分组归档（W4）', () => {
  async function freeActiveQuota(slots = 6): Promise<void> {
    const active = await t.prisma.group.count({ where: { status: 'ACTIVE' } });
    if (active <= GROUP_LIMIT - slots) return;
    const fillers = await t.prisma.group.findMany({
      where: { name: { startsWith: '占位分组' }, status: 'ACTIVE' },
      take: active - (GROUP_LIMIT - slots),
    });
    for (const filler of fillers) {
      await t.prisma.group.update({
        where: { id: filler.id },
        data: { status: 'ARCHIVED', archivedAt: '2026-09-20 00:00:00' },
      });
    }
  }

  function collectWsEvents(): { list: WsEvent[]; stop: () => void } {
    const events = t.app.get(EventsService, { strict: false });
    const list: WsEvent[] = [];
    const stop = events.registerSink((event: WsEvent) => list.push(event));
    return { list, stop };
  }

  it('组内还有未完成任务时拒绝归档：409 GROUP_NOT_ALL_DONE 且带剩余数（§5.6 置灰提示的数据源）', async () => {
    await freeActiveQuota();
    const group = await createGroup('归档校验组');
    const done = await newTask(t, { title: '组内已完成', group_id: group.body.id });
    await t.prisma.task.update({ where: { id: done }, data: { status: 'DONE' } });
    await newTask(t, { title: '组内未完成', group_id: group.body.id });

    const denied = await ui.post(`${API}/groups/${group.body.id}/archive`, {});
    expect(denied.status).toBe(409);
    expect(errorCode(denied)).toBe('GROUP_NOT_ALL_DONE');
    expect((denied.body.error as { remaining?: number }).remaining).toBe(1);

    // 「已归档」也算处理完：数据面直接给剩余任务盖归档戳（任务归档入口本身要求 DONE）。
    const pending = await t.prisma.task.findFirstOrThrow({
      where: { groupId: group.body.id, status: 'BACKLOG' },
    });
    await t.prisma.task.update({ where: { id: pending.id }, data: { archivedAt: '2026-09-20 00:00:00' } });
    const ok = await ui.post<{ status: string; archived_at: string | null }>(
      `${API}/groups/${group.body.id}/archive`,
      {},
    );
    expect(ok.status).toBe(201);
    expect(ok.body.status).toBe('ARCHIVED');
    expect(ok.body.archived_at).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it('默认分组不可归档：专门端点同样 409 GROUP_DEFAULT_PROTECTED（§5.6 末行）', async () => {
    const row = await t.prisma.group.findFirstOrThrow({ where: { isDefault: 1 } });
    const denied = await ui.post(`${API}/groups/${row.id}/archive`, {});
    expect(denied.status).toBe(409);
    expect(errorCode(denied)).toBe('GROUP_DEFAULT_PROTECTED');
  });

  it('归档分组转只读：建任务 / 迁入 409 GROUP_ARCHIVED，迁出不受限（§5.6 归档效果）', async () => {
    await freeActiveQuota(2);
    const group = await createGroup('只读验证组');
    const outside = await createGroup('外面组');
    await ui.post(`${API}/groups/${group.body.id}/archive`, {});

    const created = await ui.post(`${API}/tasks`, {
      title: '往归档组建任务',
      type: '需求',
      group_id: group.body.id,
    });
    expect(created.status).toBe(409);
    expect(errorCode(created)).toBe('GROUP_ARCHIVED');

    const mover = await newTask(t, { title: '想迁进去', group_id: outside.body.id });
    const moved = await ui.patch(`${API}/tasks/${mover}`, { group_id: group.body.id });
    expect(moved.status).toBe(409);
    expect(errorCode(moved)).toBe('GROUP_ARCHIVED');

    // 迁出归档组不受限：数据面造一个「归档前就在组内」的行，再走真实 PATCH 迁出。
    const inside = await t.prisma.task.create({
      data: { id: 'T-arch-inside', title: '组内存量', groupId: group.body.id, status: 'DONE' },
    });
    const out = await ui.patch<{ group_id: string }>(`${API}/tasks/${inside.id}`, {
      group_id: outside.body.id,
    });
    expect(out.status).toBe(200);
    expect(out.body.group_id).toBe(outside.body.id);
  });

  it('看板默认隐藏归档组任务；显式 group_id 仍可见（§5.6 归档泳道折叠区的数据面）', async () => {
    await freeActiveQuota(2);
    const group = await createGroup('泳道隐藏组');
    const id = await newTask(t, { title: '归档组看板行', group_id: group.body.id });
    await t.prisma.task.update({ where: { id }, data: { status: 'DONE' } });

    const visible = (board: { columns: { tasks: { id: string }[] }[] }) =>
      board.columns.some((column) => column.tasks.some((task) => task.id === id));

    const before = await ui.get<{ columns: { tasks: { id: string }[] }[] }>(`${API}/board`);
    expect(visible(before.body)).toBe(true);

    await ui.post(`${API}/groups/${group.body.id}/archive`, {});
    const hidden = await ui.get<{ columns: { tasks: { id: string }[] }[] }>(`${API}/board`);
    expect(visible(hidden.body)).toBe(false);
    const scoped = await ui.get<{ columns: { tasks: { id: string }[] }[] }>(
      `${API}/board?group_id=${group.body.id}`,
    );
    expect(visible(scoped.body)).toBe(true);
  });

  it('反归档：恢复 ACTIVE、archived_at 清回 null；上限已满时拒绝恢复（§5.6 查看与恢复）', async () => {
    await freeActiveQuota(2);
    const group = await createGroup('可恢复组');
    await ui.post(`${API}/groups/${group.body.id}/archive`, {});

    // 把活跃分组填回 50（数据面夹具），恢复必须撞上限。
    const active = await t.prisma.group.count({ where: { status: 'ACTIVE' } });
    for (let index = active; index < GROUP_LIMIT; index += 1) {
      await t.prisma.group.create({
        data: { id: `grp_fill_${index}`, name: `补位分组 ${index}`, status: 'ACTIVE' },
      });
    }
    const blocked = await ui.post(`${API}/groups/${group.body.id}/unarchive`, {});
    expect(blocked.status).toBe(409);
    expect(errorCode(blocked)).toBe('GROUP_LIMIT_REACHED');

    await t.prisma.group.delete({ where: { id: `grp_fill_${GROUP_LIMIT - 1}` } });
    // 上限夹具收尾清场，后面的用例不需要再和 50 名额搏斗。
    await t.prisma.group.deleteMany({ where: { id: { startsWith: 'grp_fill_' } } });
    const restored = await ui.post<{ status: string; archived_at: string | null }>(
      `${API}/groups/${group.body.id}/unarchive`,
      {},
    );
    expect(restored.status).toBe(201);
    expect(restored.body.status).toBe('ACTIVE');
    expect(restored.body.archived_at).toBeNull();
  });

  it('GET /groups 默认不含归档组，?archived=true 含（§16.2 r3）；列表带 task_count/unfinished_count', async () => {
    await freeActiveQuota(2);
    const group = await createGroup('筛选验证组');
    await newTask(t, { title: '筛选未完成', group_id: group.body.id });
    const before = await ui.get<{ items: { id: string }[] }>(`${API}/groups`);
    expect(before.body.items.some((item) => item.id === group.body.id)).toBe(true);

    const withArchived = await ui.get<{
      items: {
        id: string;
        status: string;
        archived_at: string | null;
        task_count: number;
        unfinished_count: number;
      }[];
    }>(`${API}/groups?archived=true`);
    const dto = withArchived.body.items.find((item) => item.id === group.body.id);
    expect(dto).toMatchObject({ status: 'ACTIVE', task_count: 1, unfinished_count: 1 });
    expect(dto?.archived_at).toBeNull();

    await t.prisma.task.updateMany({
      where: { groupId: group.body.id },
      data: { status: 'DONE', archivedAt: '2026-09-20 00:00:00' },
    });
    await ui.post(`${API}/groups/${group.body.id}/archive`, {});
    const defaults = await ui.get<{ items: { id: string }[] }>(`${API}/groups`);
    expect(defaults.body.items.some((item) => item.id === group.body.id)).toBe(false);
    const all = await ui.get<{ items: { id: string; status: string; archived_at: string | null }[] }>(
      `${API}/groups?archived=true`,
    );
    const archivedDto = all.body.items.find((item) => item.id === group.body.id);
    expect(archivedDto?.status).toBe('ARCHIVED');
    expect(archivedDto?.archived_at).toMatch(/^\d{4}-/);
  });

  it('归档/恢复记 group_archive / group_unarchive 审计，并推 group.archived / group.unarchived WS（§5.6 r3）', async () => {
    await freeActiveQuota(2);
    const group = await createGroup('事件验证组');
    const { list, stop } = collectWsEvents();
    try {
      await ui.post(`${API}/groups/${group.body.id}/archive`, {});
      await ui.post(`${API}/groups/${group.body.id}/unarchive`, {});
    } finally {
      stop();
    }
    expect(
      list.filter((event) => event.event === 'group.archived').map((event) => event.data),
    ).toEqual([{ id: group.body.id }]);
    expect(
      list.filter((event) => event.event === 'group.unarchived').map((event) => event.data),
    ).toEqual([{ id: group.body.id }]);
    const rows = await t.prisma.auditLog.findMany({
      where: { targetType: 'group', targetId: group.body.id, action: { in: ['group_archive', 'group_unarchive'] } },
      orderBy: { createdAt: 'asc' },
    });
    expect(rows.map((row) => row.action)).toEqual(['group_archive', 'group_unarchive']);
  });

  it('PATCH status 直改仍走同一套归档语义：未完成拒绝、archived_at 同步、重复归档幂等', async () => {
    await freeActiveQuota(2);
    const group = await createGroup('PATCH口径组');
    await newTask(t, { title: 'PATCH 未完成', group_id: group.body.id });
    const denied = await ui.patch(`${API}/groups/${group.body.id}`, { status: 'ARCHIVED' });
    expect(denied.status).toBe(409);
    expect(errorCode(denied)).toBe('GROUP_NOT_ALL_DONE');

    await t.prisma.task.updateMany({ where: { groupId: group.body.id }, data: { status: 'DONE' } });
    const via = await ui.patch<{ status: string; archived_at: string | null }>(
      `${API}/groups/${group.body.id}`,
      { status: 'ARCHIVED' },
    );
    expect(via.status).toBe(200);
    expect(via.body.archived_at).toMatch(/^\d{4}-/);

    // 幂等：重复归档（POST 入口）返回当前值，不再产生第二条归档审计。
    const again = await ui.post<{ status: string }>(`${API}/groups/${group.body.id}/archive`, {});
    expect(again.status).toBe(201);
    expect(again.body.status).toBe('ARCHIVED');
    const audits = await t.prisma.auditLog.count({
      where: { action: 'group_archive', targetId: group.body.id },
    });
    expect(audits).toBe(1);
  });
});
