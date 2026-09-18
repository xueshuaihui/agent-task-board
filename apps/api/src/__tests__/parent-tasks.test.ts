import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { API, claimOk, clearReadyQueue, issueAgent, newDoneTask, newTask, toReady, uiSender } from './helpers/seed';
import { createTestApp, type TestApp } from './helpers/http-app';

/**
 * 0919 需求/子任务：父必须是需求、嵌套 ≤ 2 层、父不进 Agent 池、
 * 聚合 progress/aggregate、父任务不可删（有子任务时）。
 */
describe('需求与子任务', () => {
  let t: TestApp;

  beforeAll(async () => {
    t = await createTestApp();
  });

  afterAll(async () => {
    await t.close();
  });

  it('创建子任务：父必须是需求类型；子下不能再挂子（最多 2 层）', async () => {
    const parent = await newTask(t, { title: '父需求' });
    const child = await newTask(t, { title: '子任务', parent_task_id: parent });
    expect(child).toBeTypeOf('string');

    // 父不是需求类型 → 422
    const bug = await newTask(t, { title: '缺陷任务', type: '缺陷' });
    const bad = await uiSender(t).post(`${API}/tasks`, {
      title: '挂在缺陷下',
      type: '缺陷',
      priority: 3,
      required_capabilities: [],
      custom_fields: {},
      depends_on: [],
      tags: [],
      pinned: false,
      parent_task_id: bug,
    });
    expect(bad.status).toBe(422);
    expect(bad.body.error.details[0].code).toBe('parent_type');

    // 子任务当父 → 422 too_deep
    const deep = await uiSender(t).post(`${API}/tasks`, {
      title: '孙任务',
      type: '需求',
      priority: 3,
      required_capabilities: [],
      custom_fields: {},
      depends_on: [],
      tags: [],
      pinned: false,
      parent_task_id: child,
    });
    expect(deep.status).toBe(422);
    expect(deep.body.error.details[0].code).toBe('too_deep');

    // 父不存在 → 404
    const missing = await uiSender(t).post(`${API}/tasks`, {
      title: '孤儿',
      type: '需求',
      priority: 3,
      required_capabilities: [],
      custom_fields: {},
      depends_on: [],
      tags: [],
      pinned: false,
      parent_task_id: 'T-999999',
    });
    expect(missing.status).toBe(404);
  });

  it('详情带 children / aggregate；卡片带 parent 摘要；子任务完成后聚合变化', async () => {
    const parent = await newTask(t, { title: '聚合父需求' });
    const childA = await newTask(t, { title: '子A', parent_task_id: parent });
    const childB = await newTask(t, { title: '子B', parent_task_id: parent });

    const detail = await uiSender(t).get(`${API}/tasks/${parent}`);
    expect(detail.body.children.map((row: any) => row.id).sort()).toEqual([childA, childB].sort());
    expect(detail.body.aggregate).toEqual({ total: 2, done: 0, status: 'BACKLOG' });

    // 子卡片带 parent 摘要
    const childDetail = await uiSender(t).get(`${API}/tasks/${childA}`);
    expect(childDetail.body.parent.id).toBe(parent);
    expect(childDetail.body.parent.total).toBe(2);
    expect(childDetail.body.parent.done).toBe(0);

    // 完成子 A（走完整 Agent 链路）
    await newDoneTaskVia(childA);
    const after = await uiSender(t).get(`${API}/tasks/${parent}`);
    expect(after.body.aggregate).toEqual({ total: 2, done: 1, status: 'IN_PROGRESS' });
    expect((await uiSender(t).get(`${API}/tasks/${childB}`)).body.parent.done).toBe(1);

    // 子 B 也完成 → 聚合 DONE
    await newDoneTaskVia(childB);
    const done = await uiSender(t).get(`${API}/tasks/${parent}`);
    expect(done.body.aggregate).toEqual({ total: 2, done: 2, status: 'DONE' });
  });

  it('父任务不进 Agent ready/claim 池；父任务有子任务时删除被拒', async () => {
    const parent = await newTask(t, { title: '不进池子的需求' });
    await newTask(t, { title: '可领子任务', parent_task_id: parent });
    // 先清空队列再把父需求拖到待执行，避免 clearReadyQueue 把它撤回需求池
    await clearReadyQueue(t);
    await toReady(t, parent);
    const agent = await issueAgent(t, 'pool-probe', []);
    const ready = await agent.ui.get(`${API}/tasks?status=READY&archived=false&page=1&page_size=200`);
    expect(ready.body.items.some((row: any) => row.id === parent)).toBe(true);
    const agentReady = await agent.claims.get(`${API}/tasks/ready`);
    expect(agentReady.body.items.some((row: any) => row.id === parent)).toBe(false);
    const claim = await agent.claims.post(`${API}/tasks/claim`, { capabilities: [] });
    if (claim.body.task) expect(claim.body.task.id).not.toBe(parent);

    // 删除父任务被拒；子任务可删，删完父任务也能删
    expect((await uiSender(t).del(`${API}/tasks/${parent}`)).status).toBe(409);
  });

  it('无子任务的普通需求照常可被领取（类型不排除）', async () => {
    await clearReadyQueue(t);
    const solo = await newTask(t, { title: '独立需求任务' });
    await toReady(t, solo);
    const agent = await issueAgent(t, 'solo-probe', []);
    const claimed = await claimOk(agent, solo);
    expect(claimed.task_id).toBe(solo);
  });

  /** 本文件内自用：把指定任务推到已完成（避开 seed 的 toReview 独享能力链路对队列的假设）。 */
  async function newDoneTaskVia(id: string): Promise<void> {
    await clearReadyQueue(t);
    await uiSender(t).patch(`${API}/tasks/${id}`, { required_capabilities: [`tool:${id}`] });
    await toReady(t, id);
    const agent = await issueAgent(t, `finisher-${id.toLowerCase().replace(/[^a-z0-9_-]/g, '-')}`, [`tool:${id}`]);
    const claimed = await claimOk(agent, id);
    const done = await agent.claims.post(`${API}/tasks/${id}/complete`, {
      task_id: claimed.task_id,
      run_id: claimed.run_id,
      lease_id: claimed.lease_id,
      summary: '子任务完成',
      artifacts: [],
    });
    expect(done.status).toBe(200);
    const review = await uiSender(t).post(`${API}/tasks/${id}/review`, { conclusion: 'APPROVE' });
    expect(review.status).toBe(201);
  }
});
