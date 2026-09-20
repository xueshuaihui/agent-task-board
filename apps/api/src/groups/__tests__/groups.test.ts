import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestApp, errorCode, type TestApp } from '../../__tests__/helpers/http-app';
import { API, newTask, uiSender } from '../../__tests__/helpers/seed';
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
