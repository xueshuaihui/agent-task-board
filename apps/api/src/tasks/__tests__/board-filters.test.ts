import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestApp, type TestApp } from '../../__tests__/helpers/http-app';
import { API, newTask, uiSender } from '../../__tests__/helpers/seed';

/**
 * B15-①：`GET /board` 统一过滤参数（groups / requirements / agents）。
 * 口径：维内 OR、维间 AND；`none` = 该维未设置（group 空、无父任务、无当前 run agent）。
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

interface BoardResponse {
  columns: { tasks: { id: string }[] }[];
}

async function boardVisible(query: string): Promise<Set<string>> {
  const res = await ui.get<BoardResponse>(`${API}/board${query ? `?${query}` : ''}`);
  expect(res.status).toBe(200);
  return new Set(res.body.columns.flatMap((column) => column.tasks.map((task) => task.id)));
}

async function createGroup(name: string): Promise<string> {
  const res = await ui.post<{ id: string }>(`${API}/groups`, { name });
  expect(res.status).toBe(201);
  return res.body.id;
}

describe('board 统一过滤参数', () => {
  it('groups 多值 = 维内 OR；未选维不隐藏无组任务', async () => {
    const groupA = await createGroup('B15 组A');
    const groupB = await createGroup('B15 组B');
    const inA = await newTask(t, { title: 'B15-A', group_id: groupA });
    const inB = await newTask(t, { title: 'B15-B', group_id: groupB });
    // 建任务缺省会落 DEFAULT_GROUP_ID，真·无组（group_id IS NULL）只能数据面造。
    const noGroup = await newTask(t, { title: 'B15-无组' });
    await t.prisma.task.update({ where: { id: noGroup }, data: { groupId: null } });

    const both = await boardVisible(`groups=${groupA},${groupB}`);
    expect(both.has(inA)).toBe(true);
    expect(both.has(inB)).toBe(true);
    expect(both.has(noGroup)).toBe(false);

    const onlyA = await boardVisible(`groups=${groupA}`);
    expect(onlyA.has(inA)).toBe(true);
    expect(onlyA.has(inB)).toBe(false);

    const none = await boardVisible(`groups=none`);
    expect(none.has(noGroup)).toBe(true);
    expect(none.has(inA)).toBe(false);
  });

  it('requirements 按父任务过滤，none = 未归属需求', async () => {
    const parent1 = await newTask(t, { title: 'B15 需求1' });
    const parent2 = await newTask(t, { title: 'B15 需求2' });
    const child1 = await newTask(t, { title: 'B15 子1', parent_task_id: parent1 });
    const child2 = await newTask(t, { title: 'B15 子2', parent_task_id: parent2 });

    const r1 = await boardVisible(`requirements=${parent1}`);
    expect(r1.has(child1)).toBe(true);
    expect(r1.has(child2)).toBe(false);

    const both = await boardVisible(`requirements=${parent1},${parent2}`);
    expect(both.has(child1)).toBe(true);
    expect(both.has(child2)).toBe(true);

    const orphan = await boardVisible(`requirements=none`);
    expect(orphan.has(parent1)).toBe(true);
    expect(orphan.has(child1)).toBe(false);
  });

  it('agents 匹配当前 run 的 agent_name，none = 无 run agent', async () => {
    const withAgent = await newTask(t, { title: 'B15-agent任务' });
    const run = await t.prisma.taskRun.create({
      data: { id: 'R-b15-agent', taskId: withAgent, agentName: 'b15-agent', runNumber: 1 },
    });
    await t.prisma.task.update({ where: { id: withAgent }, data: { currentRunId: run.id } });
    const plain = await newTask(t, { title: 'B15-无agent任务' });

    const hit = await boardVisible(`agents=b15-agent`);
    expect(hit.has(withAgent)).toBe(true);
    expect(hit.has(plain)).toBe(false);

    const miss = await boardVisible(`agents=other-agent`);
    expect(miss.has(withAgent)).toBe(false);

    const none = await boardVisible(`agents=none`);
    expect(none.has(plain)).toBe(true);
    expect(none.has(withAgent)).toBe(false);
  });

  it('维间 AND：groups × priority 交集', async () => {
    const group = await createGroup('B15 AND组');
    const hit = await newTask(t, { title: 'B15-AND命中', group_id: group, priority: 1 });
    const otherGroup = await createGroup('B15 AND他组');
    const wrongGroup = await newTask(t, { title: 'B15-AND错组', group_id: otherGroup, priority: 1 });
    const wrongPriority = await newTask(t, { title: 'B15-AND错优先级', group_id: group, priority: 3 });

    const visible = await boardVisible(`groups=${group}&priority=1`);
    expect(visible.has(hit)).toBe(true);
    expect(visible.has(wrongGroup)).toBe(false);
    expect(visible.has(wrongPriority)).toBe(false);
  });
});
