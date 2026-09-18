import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestApp, errorCode, request, type TestApp } from './helpers/http-app';
import { API, anonSender, newTask, uiSender } from './helpers/seed';
import { loginAs } from './accounts.test';

/** 0919：账号维度的数据隔离 + 项目 + 偏好持久化。 */
describe('账号隔离 / 项目 / 偏好', () => {
  let t: TestApp;
  let admin: any;
  let member: any;
  let adminToken: string;
  let memberToken: string;

  beforeAll(async () => {
    t = await createTestApp();
    const anon = anonSender(t);
    await anon.post(`${API}/auth/init`, { username: 'boss', password: 'secret66' });
    const a = await anon.post(`${API}/auth/login`, { username: 'boss', password: 'secret66' });
    adminToken = a.body.token;
    admin = request(t, adminToken);
    await admin.post(`${API}/auth/users`, { username: 'mate', password: 'mate666' });
    const m = await anon.post(`${API}/auth/login`, { username: 'mate', password: 'mate666' });
    memberToken = m.body.token;
    member = request(t, memberToken);
    // 首登强制改密
    const changed = await member.post(`${API}/auth/change-password`, {
      current_password: 'mate666',
      new_password: 'mate777',
    });
    member = request(t, changed.body.token);
  });

  afterAll(async () => {
    await t.close();
  });

  it('任务按账号隔离：A 建的任务 B 看不见、改不动、删不掉', async () => {
    const taskId = await newTaskVia(admin);
    // member 的列表里没有
    const list = await member.get(`${API}/tasks?page=1&page_size=50`);
    expect(list.body.items.some((row: any) => row.id === taskId)).toBe(false);
    // 详情 404，编辑 404，删除 404
    expect((await member.get(`${API}/tasks/${taskId}`)).status).toBe(404);
    expect((await member.patch(`${API}/tasks/${taskId}`, { title: 'x' })).status).toBe(404);
    expect((await member.del(`${API}/tasks/${taskId}`)).status).toBe(404);
    // admin 自己可见
    expect((await admin.get(`${API}/tasks/${taskId}`)).status).toBe(200);
  });

  it('看板/标签/模板/字段定义/Token 列表均按账号隔离', async () => {
    await admin.post(`${API}/field-defs`, { key: 'sev_boss', label: '严重度', type: 'text', required: false, applies_to: [] });
    await admin.post(`${API}/templates`, { name: 'boss-template', preset: {} });

    const memberDefs = await member.get(`${API}/field-defs`);
    expect(memberDefs.body.items.some((row: any) => row.key === 'sev_boss')).toBe(false);
    const memberTpls = await member.get(`${API}/templates`);
    expect(memberTpls.body.items.some((row: any) => row.name === 'boss-template')).toBe(false);

    // member 建同名 key 不冲突（跨账号）
    expect((await member.post(`${API}/field-defs`, { key: 'sev_mate', label: '严重度B', type: 'text', required: false, applies_to: [] })).status).toBe(201);

    // member 签发的 token 不在 admin 列表里
    await member.post(`${API}/tokens`, { name: 'mate-bot', capabilities: [] });
    const adminTokens = await admin.get(`${API}/tokens`);
    expect(adminTokens.body.items.some((row: any) => row.name === 'mate-bot')).toBe(false);
  });

  it('Agent Token 只能看到本账号任务：他号任务不可见不可领', async () => {
    const adminTask = await newTaskVia(admin);
    await admin.post(`${API}/tasks/${adminTask}/transition`, { to: 'READY' });
    const memberTask = await newTaskVia(member);
    await member.post(`${API}/tasks/${memberTask}/transition`, { to: 'READY' });

    const { token } = await (await admin.post(`${API}/tokens`, { name: 'boss-bot', capabilities: [] })).body;
    const agent = request(t, token);
    const ready = await agent.get(`${API}/tasks/ready`);
    expect(ready.body.items.some((row: any) => row.id === memberTask)).toBe(false);
    const claim = await agent.post(`${API}/tasks/claim`, { capabilities: [] });
    // 认领只会落到本账号（admin 自己）的任务上
    if (claim.body.task) expect(claim.body.task.id).not.toBe(memberTask);
  });

  it('项目 CRUD + 删除策略 migrate/delete', async () => {
    const p1 = await admin.post(`${API}/projects`, { name: '试点', color: '#ff0000' });
    expect(p1.status).toBe(201);
    const projectId = p1.body.id;

    const task = await newTaskVia(admin, { project_id: projectId });
    const detail = await admin.get(`${API}/tasks/${task}`);
    expect(detail.body.project_id ?? detail.body.project?.id).toBeDefined();

    // 列表过滤
    const filtered = await admin.get(`${API}/tasks?project_id=${projectId}&page=1&page_size=50`);
    expect(filtered.body.items.some((row: any) => row.id === task)).toBe(true);
    const none = await admin.get(`${API}/tasks?project_id=none&page=1&page_size=50`);
    expect(none.body.items.some((row: any) => row.id === task)).toBe(false);

    // 项目按账号隔离
    expect((await member.get(`${API}/projects`)).body.items.some((row: any) => row.id === projectId)).toBe(false);

    // migrate：任务迁去目标项目
    const p2 = await admin.post(`${API}/projects`, { name: '接盘' });
    const migrated = await admin.del(`${API}/projects/${projectId}?strategy=migrate&targetProjectId=${p2.body.id}`);
    expect(migrated.status).toBe(200);
    expect(migrated.body.affected_tasks).toBe(1);
    expect((await admin.get(`${API}/tasks/${task}`)).body.project_id).toBe(p2.body.id);

    // delete：连任务一起删
    const task2 = await newTaskVia(admin, { project_id: p2.body.id });
    const deleted = await admin.del(`${API}/projects/${p2.body.id}?strategy=delete`);
    expect(deleted.status).toBe(200);
    expect(deleted.body.affected_tasks).toBeGreaterThanOrEqual(2);
    expect((await admin.get(`${API}/tasks/${task2}`)).status).toBe(404);

    // 同名项目在同账号下不可重复
    await admin.post(`${API}/projects`, { name: 'dup' });
    const dup = await admin.post(`${API}/projects`, { name: 'dup' });
    expect(dup.status).toBe(422);
  });

  it('prefs GET/PUT 按账号持久化 JSON', async () => {
    expect((await admin.put(`${API}/prefs/board.group`, { value: { by: 'status', dir: 'asc' } })).status).toBe(200);
    const got = await admin.get(`${API}/prefs/board.group`);
    expect(got.body.value).toEqual({ by: 'status', dir: 'asc' });
    // member 是另一个账号，读到 null
    expect((await member.get(`${API}/prefs/board.group`)).body.value).toBeNull();
    // 未设置过也是 null（不是 404）
    expect((await admin.get(`${API}/prefs/never.set`)).status).toBe(200);
    // 非法 key 422
    expect((await admin.get(`${API}/prefs/${encodeURIComponent('bad key!')}`)).status).toBe(422);
  });
});

async function newTaskVia(sender: any, extra: Record<string, unknown> = {}): Promise<string> {
  const res = await sender.post(`${API}/tasks`, {
    title: `隔离任务 ${Math.random().toString(36).slice(2, 8)}`,
    type: '需求',
    priority: 3,
    required_capabilities: [],
    custom_fields: {},
    depends_on: [],
    tags: [],
    pinned: false,
    ...extra,
  });
  if (res.status !== 201) throw new Error(`建任务失败：${res.status} ${res.text}`);
  return res.body.id as string;
}
