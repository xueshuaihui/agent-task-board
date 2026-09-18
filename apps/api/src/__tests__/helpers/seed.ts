import type { Sender, TestApp } from './http-app';
import { request } from './http-app';

/**
 * 建数据一律走 HTTP（不用 prisma 直插）：这样每一步都经过真实的 zod 管道与守卫，
 * 「Agent 看得见 ≈ 领得到」这类结论才有意义。只有制造时间差（租约过期）才直改库。
 */

export interface IssuedAgent {
  id: string;
  token: string;
  name: string;
  ui: Sender;
  claims: Sender;
}

export const API = '/api/v1';

export function uiSender(t: TestApp): Sender {
  return request(t, t.uiToken);
}

export function anonSender(t: TestApp): Sender {
  return request(t, null);
}

/** 13 章：Agent Token 只能由用户接口签出，明文仅这一次响应里有。 */
export async function issueAgent(
  t: TestApp,
  name = `qoder-${Math.random().toString(36).slice(2, 8)}`,
  capabilities: string[] = [],
): Promise<IssuedAgent> {
  const ui = uiSender(t);
  const res = await ui.post(`${API}/tokens`, { name, capabilities });
  if (res.status !== 201) throw new Error(`签发 Token 失败：${res.status} ${res.text}`);
  return {
    id: res.body.id as string,
    token: res.body.token as string,
    name,
    ui,
    claims: request(t, res.body.token as string),
  };
}

export interface NewTaskInput {
  title?: string;
  type?: string;
  parent_task_id?: string;
  project_id?: string;
  priority?: number;
  required_capabilities?: string[];
  custom_fields?: Record<string, unknown>;
  depends_on?: string[];
  tags?: string[];
  description?: string;
  pinned?: boolean;
}

/** 创建后一律停在需求池（6.9.2：必填的拦截点是「拖到待执行」，不是创建）。 */
export async function newTask(t: TestApp, input: NewTaskInput = {}): Promise<string> {
  const ui = uiSender(t);
  const payload: Record<string, unknown> = {
    title: input.title ?? `集成任务 ${Math.random().toString(36).slice(2, 8)}`,
    type: input.type ?? '需求',
    priority: input.priority ?? 3,
    required_capabilities: input.required_capabilities ?? [],
    custom_fields: input.custom_fields ?? {},
    depends_on: input.depends_on ?? [],
    tags: input.tags ?? [],
    pinned: input.pinned ?? false,
  };
  // 13 章创建入参的 description 是 optional 而非 nullable，缺省就别带。
  if (input.description !== undefined) payload.description = input.description;
  if (input.parent_task_id !== undefined) payload.parent_task_id = input.parent_task_id;
  if (input.project_id !== undefined) payload.project_id = input.project_id;
  const res = await ui.post(`${API}/tasks`, payload);
  if (res.status !== 201) throw new Error(`建任务失败：${res.status} ${res.text}`);
  return res.body.id as string;
}

export async function toReady(t: TestApp, id: string): Promise<void> {
  const res = await uiSender(t).post(`${API}/tasks/${id}/transition`, { to: 'READY' });
  if (res.status !== 201) throw new Error(`移入待执行失败 ${id}：${res.status} ${res.text}`);
}

/** 当前待执行队列（人类视角的顺序，与 Agent 抓取顺序同源：归档任务不算）。 */
export async function readyTaskIds(t: TestApp): Promise<string[]> {
  const res = await uiSender(t).get<{ items: { id: string }[] }>(
    `${API}/tasks?status=READY&archived=false&sort=created_at&order=asc&page_size=200`,
  );
  if (res.status !== 200) throw new Error(`读取待执行队列失败：${res.status} ${res.text}`);
  return res.body.items.map((item) => item.id);
}

/**
 * 把待执行队列挪空（回需求池，不删数据）。
 *
 * 认领取的是「第一个匹配候选」（5.6：`pinned DESC, priority ASC, created_at ASC`），
 * 而能力为空的任务对任何 Token 都算匹配 —— 前面用例留在 READY 里的任务会把认领抢走，
 * 断言就变成在测队列历史。需要精确领到某一条、或验证「队列真空」的用例先调它。
 */
export async function clearReadyQueue(t: TestApp): Promise<void> {
  const ui = uiSender(t);
  for (const id of await readyTaskIds(t)) {
    const res = await ui.post(`${API}/tasks/${id}/transition`, { to: 'BACKLOG' });
    if (res.status !== 201) throw new Error(`清空队列失败 ${id}：${res.status} ${res.text}`);
  }
  const left = await readyTaskIds(t);
  if (left.length > 0) throw new Error(`队列未能清空：${left.join(', ')}`);
}

export interface Lease {
  task_id: string;
  run_id: string;
  lease_id: string;
}

/**
 * 认领响应里的租约三元组：写回侧四个端点都只认它。
 *
 * 同时吃两种入参——`tasks/claim` 的原始 body（`{task, lease}`）和 `claimOk()` 已经摊平的
 * 结果——返回值固定只有三个键，`{...triple(x)}` 拼回写 body 时不会漏进别的字段。
 */
export function triple(
  claimed:
    | Lease
    | { task: { id: string }; lease: { run_id: string; lease_id: string } },
): Lease {
  const flat = claimed as Partial<Lease>;
  if (flat.task_id && flat.run_id && flat.lease_id) {
    return { task_id: flat.task_id, run_id: flat.run_id, lease_id: flat.lease_id };
  }
  const raw = claimed as { task: { id: string }; lease: { run_id: string; lease_id: string } };
  return {
    task_id: raw.task.id,
    run_id: raw.lease.run_id,
    lease_id: raw.lease.lease_id,
  };
}

export async function claimOne(
  agent: IssuedAgent,
  body: Record<string, unknown> = {},
): Promise<{ status: number; body: any }> {
  const res = await agent.claims.post(`${API}/tasks/claim`, body);
  return { status: res.status, body: res.body };
}

/**
 * 把租约到期时刻挪到「现在 + modifier」这条 SQL 偏移上（`-1 minutes` 即已过期）。
 * 时间与租约写入同一个时钟（SQLite `datetime('now')`），不依赖真实定时器。
 */
export async function shiftLeaseExpiry(t: TestApp, taskId: string, modifier: string): Promise<string> {
  await t.prisma.$executeRawUnsafe(
    `UPDATE tasks SET lease_expires_at = datetime('now', ?) WHERE id = ?`,
    modifier,
    taskId,
  );
  const rows = await t.prisma.$queryRawUnsafe<{ lease_expires_at: string }[]>(
    `SELECT lease_expires_at FROM tasks WHERE id = ?`,
    taskId,
  );
  return rows[0]?.lease_expires_at ?? '';
}

export async function dbNow(t: TestApp, modifier = ''): Promise<string> {
  const rows = modifier
    ? await t.prisma.$queryRawUnsafe<{ now: string }[]>(`SELECT datetime('now', ?) AS now`, modifier)
    : await t.prisma.$queryRawUnsafe<{ now: string }[]>(`SELECT datetime('now') AS now`);
  return rows[0]!.now;
}

export async function taskStatus(t: TestApp, id: string): Promise<string> {
  const rows = await t.prisma.$queryRawUnsafe<{ status: string }[]>(
    `SELECT status FROM tasks WHERE id = ?`,
    id,
  );
  return rows[0]?.status ?? '(gone)';
}

export async function createFieldDef(
  t: TestApp,
  input: Partial<{
    key: string;
    label: string;
    type: string;
    required: boolean;
    options: string[];
    applies_to: string[];
    show_on_card: boolean;
  }> = {},
): Promise<string> {
  const res = await uiSender(t).post(`${API}/field-defs`, {
    key: input.key ?? 'severity',
    label: input.label ?? '严重度',
    type: input.type ?? 'select',
    required: input.required ?? true,
    options: input.options ?? ['高', '低'],
    applies_to: input.applies_to ?? [],
    show_on_card: input.show_on_card ?? false,
  });
  if (res.status !== 201) throw new Error(`建字段定义失败：${res.status} ${res.text}`);
  return res.body.id as string;
}

/** 认领必须成功时用这个：领不到、或领到的不是预期的那条，都直接抛，免得断言在 `undefined.id` 上炸成看不懂的错误。 */
export async function claimOk(
  agent: IssuedAgent,
  expectId?: string,
  body: Record<string, unknown> = {},
): Promise<Lease & { task: any; expires_at: string; ttl_minutes: number }> {
  const res = await agent.claims.post(`${API}/tasks/claim`, body);
  if (res.status !== 200 || !res.body.task) {
    throw new Error(`认领失败：${res.status} ${res.text}`);
  }
  if (expectId && res.body.task.id !== expectId) {
    throw new Error(`期望认领 ${expectId}，实际领到 ${res.body.task.id}`);
  }
  return {
    task_id: res.body.task.id as string,
    run_id: res.body.lease.run_id as string,
    lease_id: res.body.lease.lease_id as string,
    task: res.body.task,
    expires_at: res.body.lease.expires_at as string,
    ttl_minutes: res.body.lease.ttl_minutes as number,
  };
}

/**
 * 走完整条 Agent 链路把任务推进待审核：建 → 待执行 → 认领 → 完成回写。
 *
 * 认领按 `pinned DESC, priority ASC, created_at ASC` 取**第一个匹配项**，而能力为空的任务对
 * 任何 Token 都匹配，所以这里做两件事锁死目标：先清空待执行队列，再给任务打独享能力标记
 * `tool:<id>`、用只声明该能力的 Token 认领（顺带复用 20.5 的子集判定）。
 */
export async function toReview(t: TestApp, id: string): Promise<Lease> {
  await clearReadyQueue(t);
  await uiSender(t).patch(`${API}/tasks/${id}`, { required_capabilities: [`tool:${id}`] });
  await toReady(t, id);
  const agent = await issueAgent(t, `worker-${id.toLowerCase().replace(/[^a-z0-9_-]/g, '-')}`, [
    `tool:${id}`,
  ]);
  const claimed = await claimOk(agent, id);
  const done = await agent.claims.post(`${API}/tasks/${id}/complete`, {
    ...triple(claimed),
    summary: `${id} 已完成`,
    artifacts: [],
  });
  if (done.status !== 200) throw new Error(`完成回写失败：${done.status} ${done.text}`);
  return triple(claimed);
}

export async function review(
  t: TestApp,
  id: string,
  body: Record<string, unknown>,
): Promise<{ status: number; body: any; text: string }> {
  const res = await uiSender(t).post(`${API}/tasks/${id}/review`, body);
  return { status: res.status, body: res.body, text: res.text };
}

export async function approve(t: TestApp, id: string): Promise<void> {
  const res = await review(t, id, {
    conclusion: 'APPROVE',
    suggestion: '实现符合要求',
    reason: '边界处理完整',
    detail: '补了回归测试',
  });
  if (res.status !== 201) throw new Error(`审核通过失败：${res.status} ${res.text}`);
}

/** 建任务并直接推到已完成：依赖解锁、归档这类链路都要它当起点。 */
export async function newDoneTask(t: TestApp, title: string): Promise<string> {
  const id = await newTask(t, { title });
  await toReview(t, id);
  await approve(t, id);
  return id;
}

/**
 * 4.3.2 的「孤儿回写」前提：租约仍有效、任务状态已非 RUNNING。
 * HTTP 侧造不出这个组合（人在任务 RUNNING 时拖不动也删不掉），只能像 writeback.test.ts
 * 那样倒改 tasks.status —— 这里把它收进 helper，免得每个用例各自写裸 SQL。
 */
export async function setStatusDirect(t: TestApp, id: string, status: string): Promise<void> {
  await t.prisma.$executeRawUnsafe(
    `UPDATE tasks SET status = ?, current_run_id = NULL WHERE id = ?`,
    status,
    id,
  );
}

export interface Fixture {
  id: string;
  /** 造到执行中及之后状态时用的是这个专用 Token，用例可以继续拿它回写。 */
  agent: IssuedAgent;
  /** 最近一次认领的三元组；未认领过的状态（需求池 / 待执行 / 已归档）为 null。 */
  key: Lease | null;
}

/**
 * 把一条新任务造到指定状态，四.五 矩阵与租约用例都以它为起点。
 *
 * 全程走真实 HTTP（认领产生的执行中状态是造不出假的前置），并且每条分支都先清空待执行队列
 * 再用独享能力标记锁定目标——否则后建的夹具会领到前一个夹具留下的待执行任务。
 */
export async function taskIn(
  t: TestApp,
  status: 'BACKLOG' | 'READY' | 'RUNNING' | 'REVIEW' | 'DONE' | 'FAILED',
  title = `状态夹具 ${status}`,
): Promise<Fixture> {
  const id = await newTask(t, { title });
  if (status === 'BACKLOG') return { id, agent: await issueAgent(t), key: null };

  if (status === 'READY') {
    await clearReadyQueue(t);
    await toReady(t, id);
    return { id, agent: await issueAgent(t), key: null };
  }

  await clearReadyQueue(t);
  await uiSender(t).patch(`${API}/tasks/${id}`, { required_capabilities: [`tool:${id}`] });
  await toReady(t, id);
  const agent = await issueAgent(t, `fixture-${id.toLowerCase().replace(/[^a-z0-9_-]/g, '-')}`, [
    `tool:${id}`,
  ]);
  const claimed = await claimOk(agent, id);
  const key = triple(claimed);
  if (status === 'RUNNING') return { id, agent, key };

  const reported = await agent.claims.post(
    `${API}/tasks/${id}/${status === 'FAILED' ? 'fail' : 'complete'}`,
    status === 'FAILED'
      ? { ...key, error: '夹具：依赖不可达', summary: '夹具：上报失败' }
      : { ...key, summary: '夹具：已完成', artifacts: [] },
  );
  if (reported.status !== 200) {
    throw new Error(`夹具回写失败：${reported.status} ${reported.text}`);
  }
  if (status === 'REVIEW' || status === 'FAILED') return { id, agent, key };

  await approve(t, id);
  return { id, agent, key };
}
