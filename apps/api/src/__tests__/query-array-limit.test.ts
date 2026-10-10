import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestApp, type TestApp } from './helpers/http-app';
import { API, createFieldDef, newTask, uiSender } from './helpers/seed';

/**
 * D-1（R7 web 面全量回归）的管线级证据：≥21 个同名多值查询参数过真 HTTP 不再是 422。
 *
 * 病根在 Express 的 query parser（qs 默认 `arrayLimit=20`，越界项退化成数字键对象），
 * 症状却出现在下游 zod：`stringListSchema` 只吃 `string | string[]`，于是 21 个值判成
 * `invalid_union` → `422 VALIDATION_FAILED`。这里请求打的是 `helpers/http-app.ts` 起的真
 * sidecar，而它的 query parser 与 `src/main.ts` 引用同一个 `infra/query-parser.ts`——
 * 测过的就是生产跑的那一份配置。
 *
 * 每条用例都不只断状态码：还断**第 21 个值真的参与了筛选**。只断 200 的话，
 * 「参数被静默丢掉」这种更坏的失败也会一起放过。
 */

interface BoardResponse {
  columns: { tasks: { id: string }[] }[];
}

interface ListResponse {
  items: { id: string }[];
  total: number;
}

/** 本文件的数据：21 个需求（父任务）各挂一个子任务，下标即查询串里的第 N 个值。 */
const parents: string[] = [];
const children: string[] = [];

/** `?requirements[]=a&requirements[]=b`：curl / Agent 面手写的方括号形态（缺陷复现用的就是这个）。 */
function bracketParams(ids: string[]): string {
  return ids.map((id) => `requirements[]=${encodeURIComponent(id)}`).join('&');
}

/** `?requirements=a&requirements=b`：web `buildQuery` 对数组发的重复键形态。 */
function repeatedParams(ids: string[], key = 'requirements'): string {
  return ids.map((id) => `${key}=${encodeURIComponent(id)}`).join('&');
}

function idsOf(body: BoardResponse): Set<string> {
  return new Set(body.columns.flatMap((column) => column.tasks.map((task) => task.id)));
}

let t: TestApp;
let ui: ReturnType<typeof uiSender>;

beforeAll(async () => {
  t = await createTestApp();
  ui = uiSender(t);
  for (let i = 0; i < 21; i += 1) {
    const parent = await newTask(t, { title: `D-1 需求 ${i}` });
    parents.push(parent);
    children.push(await newTask(t, { title: `D-1 子任务 ${i}`, parent_task_id: parent }));
  }
}, 180_000);

afterAll(async () => {
  await t?.close();
});

describe('board 的 requirements 多值边界（D-1）', () => {
  it('21 个方括号参数：200 且第 21 个值参与筛选', async () => {
    const res = await ui.get<BoardResponse>(`${API}/board?view=all&${bracketParams(parents)}`);
    // 缺陷形态是 422 `{error.code:VALIDATION_FAILED, details:[{path:'requirements',code:'invalid_union'}]}`。
    expect(res.status, `21 个方括号值应 200，实际 ${res.status}：${res.text.slice(0, 300)}`).toBe(200);
    const visible = idsOf(res.body);
    for (const [index, child] of children.entries()) {
      expect(visible.has(child), `第 ${index + 1} 个子任务应被筛中`).toBe(true);
    }
    // 需求本体（parent_task_id 为空）不该出现在结果里：筛的是「这些需求下的子任务」。
    expect(visible.has(parents[20]!)).toBe(false);
  });

  it('21 个重复键（web 的序列化）：同样 200 且全命中', async () => {
    const res = await ui.get<BoardResponse>(`${API}/board?view=all&${repeatedParams(parents)}`);
    expect(res.status, `21 个重复键应 200，实际 ${res.status}：${res.text.slice(0, 300)}`).toBe(200);
    const visible = idsOf(res.body);
    for (const child of children) expect(visible.has(child)).toBe(true);
  });

  it('25 个值（越过 21 更远）：200 且真需求下的子任务全命中', async () => {
    const ids = [...parents, 'R-nope-1', 'R-nope-2', 'R-nope-3', 'R-nope-4'];
    expect(ids).toHaveLength(25);
    const res = await ui.get<BoardResponse>(`${API}/board?view=all&${bracketParams(ids)}`);
    expect(res.status, `25 个值应 200，实际 ${res.status}：${res.text.slice(0, 300)}`).toBe(200);
    const visible = idsOf(res.body);
    for (const child of children) expect(visible.has(child)).toBe(true);
  });

  it('20 个的旧正例不回归：200，且第 21 条被筛掉（限额不是「全放行」）', async () => {
    const first20 = parents.slice(0, 20);
    const res = await ui.get<BoardResponse>(`${API}/board?${repeatedParams(first20)}`);
    expect(res.status, `20 个值应仍 200，实际 ${res.status}：${res.text.slice(0, 300)}`).toBe(200);
    const visible = idsOf(res.body);
    for (const child of children.slice(0, 20)) expect(visible.has(child)).toBe(true);
    // 反向半句：不在 20 个值里的第 21 个孩子必须不出现——否则就是筛选条件被忽略了。
    expect(visible.has(children[20]!)).toBe(false);
  });

  it('逗号拼接的单值形态仍 200：`?requirements=a,b,c`', async () => {
    const first3 = parents.slice(0, 3);
    const res = await ui.get<BoardResponse>(
      `${API}/board?requirements=${first3.map((id) => encodeURIComponent(id)).join(',')}`,
    );
    expect(res.status, `逗号形态应 200，实际 ${res.status}：${res.text.slice(0, 300)}`).toBe(200);
    const visible = idsOf(res.body);
    for (const child of children.slice(0, 3)) expect(visible.has(child)).toBe(true);
    expect(visible.has(children[3]!)).toBe(false);
  });
});

describe('其余多值与嵌套形态：抬限额后仍按契约走', () => {
  it('tasks 的 tags 给 21 个值：200 且第 21 个标签命中的任务在结果里', async () => {
    const tagged = await newTask(t, { title: 'D-1 带第 21 个标签', tags: ['tag-20'] });
    const tags = Array.from({ length: 21 }, (_, i) => `tag-${i}`);
    const res = await ui.get<ListResponse>(
      `${API}/tasks?${repeatedParams(tags, 'tags')}&archived=all&sort=id&order=asc`,
    );
    expect(res.status, `21 个 tags 应 200，实际 ${res.status}：${res.text.slice(0, 300)}`).toBe(200);
    expect(res.body.items.map((item) => item.id)).toContain(tagged);
  });

  it('嵌套键 `custom_fields[key]=v` 在抬限额后仍解析成对象（20.7 不回归）', async () => {
    await createFieldDef(t, {
      key: 'd1_severity',
      label: 'D-1 严重度',
      type: 'select',
      required: false,
      options: ['高', '低'],
    });
    const hit = await newTask(t, { title: 'D-1 带自定义字段的任务', custom_fields: { d1_severity: '高' } });
    const query = `custom_fields[d1_severity]=${encodeURIComponent('高')}`;
    const res = await ui.get<BoardResponse>(`${API}/board?${query}`);
    expect(res.status, `嵌套键应 200，实际 ${res.status}：${res.text.slice(0, 300)}`).toBe(200);
    const visible = idsOf(res.body);
    // 命中的只该是这条任务：21 个需求下的子任务都没有 d1_severity，它们若出现，
    // 说明条件被静默忽略了——那是嵌套解析坏掉的另一种表现，比 422 更坏。
    expect(visible.has(hit)).toBe(true);
    expect(visible.has(children[0]!)).toBe(false);
  });
});
