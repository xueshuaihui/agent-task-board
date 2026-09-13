import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { USER_COPY } from '../contract/errors';
import { createTestApp, errorCode, errorMessage, type TestApp } from './helpers/http-app';
import {
  API,
  approve,
  claimOk,
  clearReadyQueue,
  issueAgent,
  newTask,
  readyTaskIds,
  taskIn,
  toReady,
  triple,
  uiSender,
  type IssuedAgent,
} from './helpers/seed';

/**
 * 5.5 / 5.7 / 6.13 的依赖链：阻塞过滤、完成解锁、环检测、归档与删除对下游的影响。
 *
 * 「阻塞」在服务端只有一处定义：CANDIDATE_SELECT 里那条
 * `NOT EXISTS (blocks 边且前置 status != 'DONE')`，看板的 ready 列表与认领候选集共用它，
 * 所以这里两条口都要对同一条任务给出一致答案（看得见 ≈ 领得到）。
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

async function agentReady(): Promise<string[]> {
  const agent = await issueAgent(t, `reader-${Math.random().toString(36).slice(2, 8)}`);
  const res = await agent.claims.get(`${API}/tasks/ready`);
  expect(res.status).toBe(200);
  return res.body.items.map((item: { id: string }) => item.id);
}

async function addDep(id: string, dependsOn: string, type = 'blocks') {
  return ui.post(`${API}/tasks/${id}/dependencies`, { depends_on: dependsOn, type });
}

/** 不用 seed.toReview：它会清空待执行队列，本文件的用例正要把下游任务留在队列里。 */
async function driveToReview(t: TestApp, id: string): Promise<IssuedAgent> {
  await uiSender(t).patch(`${API}/tasks/${id}`, { required_capabilities: [`tool:${id}`] });
  await toReady(t, id);
  const agent = await issueAgent(t, `doer-${id.toLowerCase().replace(/[^a-z0-9_-]/g, '-')}`, [
    `tool:${id}`,
  ]);
  const key = triple(await claimOk(agent, id));
  const done = await agent.claims.post(`${API}/tasks/${id}/complete`, {
    ...key,
    summary: '依赖链里的完成回写',
    artifacts: [],
  });
  expect(done.status).toBe(200);
  return agent;
}

describe('阻塞与解锁', () => {
  it('前置未完成：下游在 ready 与认领候选集里同时消失', async () => {
    await clearReadyQueue(t);
    const upstream = await newTask(t, { title: '前置：接口设计' });
    const downstream = await newTask(t, { title: '后置：写实现' });
    expect((await addDep(downstream, upstream)).status).toBe(201);
    await toReady(t, downstream);

    expect(await readyTaskIds(t)).toEqual([downstream]);
    expect(await agentReady()).not.toContain(downstream);

    const blocked = await ui.get(`${API}/tasks/${downstream}`);
    expect(blocked.body.status).toBe('READY');
    expect(blocked.body.blocked).toEqual({
      count: 1,
      by: [{ id: upstream, title: '前置：接口设计' }],
    });
    // 看板的「可领取」视图同样过滤阻塞，只有 blocked 视图把它列出来（5.5）。
    const readyView = await ui.get(`${API}/board?view=claimable`);
    const readyColumn = readyView.body.columns.find((c: { status: string }) => c.status === 'READY');
    expect(readyColumn.tasks.map((task: { id: string }) => task.id)).not.toContain(downstream);
    const blockedView = await ui.get(`${API}/board?view=blocked`);
    const blockedColumn = blockedView.body.columns.find(
      (c: { status: string }) => c.status === 'READY',
    );
    expect(blockedColumn.tasks.map((task: { id: string }) => task.id)).toContain(downstream);

    // 领不到：队列里只有这一条，而它被阻塞 → 候选集为空。
    const claimer = await issueAgent(t, 'blocked-claimer');
    const res = await claimer.claims.post(`${API}/tasks/claim`, {});
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ task: null, reason: 'no_ready_task' });
    expect((await ui.get(`${API}/tasks/${downstream}`)).body.status).toBe('READY');
  });

  it('前置进入已完成的瞬间解锁下游，并留下一条解锁通知', async () => {
    await clearReadyQueue(t);
    const upstream = await newTask(t, { title: '前置：迁移脚本' });
    const downstream = await newTask(t, { title: '后置：跑迁移' });
    await addDep(downstream, upstream);
    await toReady(t, downstream);
    const notificationsBefore = await t.prisma.notification.count({
      where: { kind: 'task_unblocked' },
    });

    await driveToReview(t, upstream);
    // 待审核还不算完成：解锁发生在 DONE，不在 REVIEW。
    expect(await agentReady()).not.toContain(downstream);

    await approve(t, upstream);
    const ready = await agentReady();
    expect(ready).toContain(downstream);
    expect((await ui.get(`${API}/tasks/${downstream}`)).body.blocked.count).toBe(0);
    expect(
      await t.prisma.notification.count({ where: { kind: 'task_unblocked', taskId: downstream } }),
    ).toBe(1);
    expect(
      await t.prisma.notification.count({ where: { kind: 'task_unblocked' } }),
    ).toBe(notificationsBefore + 1);

    // 解锁后即可认领，走的是同一条 CANDIDATE_SELECT。
    const claimer = await issueAgent(t, 'unlocked-claimer');
    const claimed = await claimOk(claimer, downstream);
    expect((await ui.get(`${API}/tasks/${downstream}`)).body.status).toBe('RUNNING');
    expect(claimed.task.id).toBe(downstream);
  });

  it('多个前置：只要有一个未完成就继续阻塞，全部完成才解锁', async () => {
    await clearReadyQueue(t);
    const left = await newTask(t, { title: '前置一' });
    const right = await newTask(t, { title: '前置二' });
    const both = await newTask(t, { title: '两个前置都要' });
    await addDep(both, left);
    await addDep(both, right);
    await toReady(t, both);

    await driveToReview(t, left);
    await approve(t, left);
    expect(await agentReady()).not.toContain(both);
    expect((await ui.get(`${API}/tasks/${both}`)).body.blocked).toMatchObject({
      count: 1,
      by: [{ id: right }],
    });

    await driveToReview(t, right);
    await approve(t, right);
    expect(await agentReady()).toContain(both);
    expect((await ui.get(`${API}/tasks/${both}`)).body.blocked.count).toBe(0);
  });

  it('relates 只表示关联，不参与阻塞', async () => {
    await clearReadyQueue(t);
    const related = await newTask(t, { title: '相关任务' });
    const target = await newTask(t, { title: '不受影响' });
    expect((await addDep(target, related, 'relates')).status).toBe(201);
    await toReady(t, target);

    expect(await agentReady()).toContain(target);
    expect((await ui.get(`${API}/tasks/${target}`)).body.blocked.count).toBe(0);
    // 依赖端点按方向分组（我的前置 / 我挡住的），类型在每条边的 type 上。
    const ofTarget = await ui.get(`${API}/tasks/${target}/dependencies`);
    expect(ofTarget.body.depends_on).toHaveLength(1);
    expect(ofTarget.body.depends_on[0]).toMatchObject({ id: related, type: 'relates' });
    expect(ofTarget.body.blocks).toEqual([]);
    const ofRelated = await ui.get(`${API}/tasks/${related}/dependencies`);
    expect(ofRelated.body.depends_on).toEqual([]);
    expect(ofRelated.body.blocks[0]).toMatchObject({ id: target, type: 'relates' });

    const claimed = await claimOk(await issueAgent(t, 'relates-claimer'), target);
    expect(claimed.task_id).toBe(target);
  });

  it('删除依赖行后立刻恢复可见与可领', async () => {
    await clearReadyQueue(t);
    const upstream = await newTask(t, { title: '将被解绑的前置' });
    const downstream = await newTask(t, { title: '解绑后可领' });
    await addDep(downstream, upstream);
    await toReady(t, downstream);
    expect(await agentReady()).not.toContain(downstream);

    const depId = (await ui.get(`${API}/tasks/${downstream}`)).body.depends_on[0].dep_id;
    const removed = await ui.del(`${API}/tasks/${downstream}/dependencies/${depId}`);
    expect(removed.status).toBe(200);
    expect(removed.body.depends_on).toEqual([]);
    expect(await agentReady()).toContain(downstream);
    const claimed = await claimOk(await issueAgent(t, 'rebound-claimer'), downstream);
    expect(claimed.task_id).toBe(downstream);
  });

  it('删除前置任务：下游立即解锁并在响应里给出 unblocked_ids', async () => {
    await clearReadyQueue(t);
    const upstream = await newTask(t, { title: '会被删掉的前置' });
    const downstream = await newTask(t, { title: '因删除而解锁' });
    await addDep(downstream, upstream);
    await toReady(t, downstream);

    const deleted = await ui.del(`${API}/tasks/${upstream}`);
    expect(deleted.status).toBe(200);
    expect(deleted.body.unblocked_ids).toEqual([downstream]);
    expect(await agentReady()).toContain(downstream);
    expect((await ui.get(`${API}/tasks/${downstream}`)).body.blocked.count).toBe(0);
  });
});

describe('环检测（5.7）', () => {
  it('两节点回边：409 DEPENDENCY_CYCLE，message 里带完整链路，且不落库', async () => {
    const a = await newTask(t, { title: '环上的 A' });
    const b = await newTask(t, { title: '环上的 B' });
    await addDep(b, a);

    const res = await addDep(a, b);
    expect(res.status).toBe(409);
    expect(errorCode(res)).toBe('DEPENDENCY_CYCLE');
    // 链路从「新加的前置」走到「被编辑的任务」：b 已在 a 之前，故为 B → A。
    expect(errorMessage(res)).toBe(USER_COPY.dependencyCycle(`${b} 环上的 B → ${a} 环上的 A`));
    expect(errorMessage(res)).toContain('已取消保存');

    const after = await ui.get(`${API}/tasks/${a}/dependencies`);
    expect(after.body).toEqual({ depends_on: [], blocks: [{ id: b, dep_id: expect.any(String), title: '环上的 B', status: 'BACKLOG', type: 'blocks' }] });
  });

  it('三节点长环也要被识破：C→B→A 后加 A→C', async () => {
    const a = await newTask(t, { title: '长环 A' });
    const b = await newTask(t, { title: '长环 B' });
    const c = await newTask(t, { title: '长环 C' });
    await addDep(b, a);
    await addDep(c, b);

    const res = await addDep(a, c);
    expect(res.status).toBe(409);
    expect(errorCode(res)).toBe('DEPENDENCY_CYCLE');
    const message = errorMessage(res)!;
    for (const id of [a, b, c]) expect(message).toContain(id);
    expect(message.split(' → ')).toHaveLength(3);
  });

  it('依赖自己：409 DEPENDENCY_CYCLE，理由单独一句', async () => {
    const id = await newTask(t, { title: '自环' });
    const res = await addDep(id, id);
    expect(res.status).toBe(409);
    expect(errorCode(res)).toBe('DEPENDENCY_CYCLE');
    expect(errorMessage(res)).toBe('任务不能依赖自身');
  });

  it('relates 允许成环：只有 blocks 参与检测', async () => {
    const a = await newTask(t, { title: '关联 A' });
    const b = await newTask(t, { title: '关联 B' });
    expect((await addDep(b, a)).status).toBe(201);
    expect((await addDep(a, b, 'relates')).status).toBe(201);
    const blocked = await addDep(a, b);
    expect(blocked.status).toBe(409);
  });
});

describe('依赖对归档与批量操作的影响', () => {
  it('归档仍是未完成任务的前置：409 ARCHIVE_BLOCKED_BY_DEPENDENCY + 下游清单', async () => {
    const upstream = await taskIn(t, 'DONE', '被依赖的已完成');
    const downstream = await newTask(t, { title: '还没做的下游' });
    await addDep(downstream, upstream.id);

    const res = await ui.post(`${API}/tasks/${upstream.id}/archive`, {});
    expect(res.status).toBe(409);
    expect(errorCode(res)).toBe('ARCHIVE_BLOCKED_BY_DEPENDENCY');
    expect(errorMessage(res)).toBe(USER_COPY.archiveBlocked(1));
    expect(res.body.error.downstream).toEqual([downstream]);

    // 下游自己也被批量归档挡住（同一个判定），逐条报原因。
    const batch = await ui.post(`${API}/tasks/batch/archive`, { ids: [upstream.id] });
    expect(batch.status).toBe(201);
    expect(batch.body.succeeded).toEqual([]);
    expect(batch.body.skipped[0].reason).toContain('ARCHIVE_BLOCKED_BY_DEPENDENCY');

    // 下游完成后即可归档。
    await driveToReview(t, downstream);
    await approve(t, downstream);
    const archived = await ui.post(`${API}/tasks/${upstream.id}/archive`, {});
    expect(archived.status).toBe(201);
    expect(archived.body.archived).toBe(true);
  });

  it('前置已完成即不挡下游：阻塞只看状态，与下游自身与归档标记无关', async () => {
    const upstream = await taskIn(t, 'DONE', '已完成的前置');
    const downstream = await newTask(t, { title: '等已完成前置' });
    await addDep(downstream, upstream.id);
    await toReady(t, downstream);

    expect((await ui.get(`${API}/tasks/${downstream}`)).body.blocked.count).toBe(0);
    expect(await agentReady()).toContain(downstream);
    // 上游被下游反过来挡住归档（上一条用例），但它的 DONE 不会因此回退成阻塞。
    const archived = await ui.post(`${API}/tasks/${upstream.id}/archive`, {});
    expect(archived.status).toBe(409);
    expect(errorCode(archived)).toBe('ARCHIVE_BLOCKED_BY_DEPENDENCY');
    expect((await ui.get(`${API}/tasks/${downstream}`)).body.blocked.count).toBe(0);
  });

  it('批量归档：前置未完成的项进 skipped，不影响同批其他项', async () => {
    const free = await taskIn(t, 'DONE', '可归档');
    const held = await taskIn(t, 'DONE', '被下游拖着');
    const downstream = await newTask(t, { title: '下游未完' });
    await addDep(downstream, held.id);

    const res = await ui.post(`${API}/tasks/batch/archive`, { ids: [free.id, held.id] });
    expect(res.status).toBe(201);
    expect(res.body.succeeded).toEqual([free.id]);
    expect(res.body.skipped).toHaveLength(1);
    expect(res.body.skipped[0]).toMatchObject({ id: held.id });
    expect((await ui.get(`${API}/tasks/${free.id}`)).body.archived_at).not.toBeNull();
    expect((await ui.get(`${API}/tasks/${held.id}`)).body.archived_at).toBeNull();
  });
});
