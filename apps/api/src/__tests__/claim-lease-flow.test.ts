import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { USER_COPY } from '../contract/errors';
import {
  createTestApp,
  errorCode,
  errorMessage,
  type TestApp,
} from './helpers/http-app';
import {
  API,
  claimOk,
  clearReadyQueue,
  issueAgent,
  newTask,
  shiftLeaseExpiry,
  taskStatus,
  toReady,
  triple,
  uiSender,
} from './helpers/seed';

/**
 * 4.3 / 4.4 / 9.3 的主链路：建任务 → 拖到待执行 → Agent 看得见 → 认领 → 心跳 → 进度与日志
 * → 完成回写（含幂等重放）→ 待审核。验收 5/6/7/11/12/13/35/40。
 *
 * 每个用例自己造任务，队列里同时只有一个可领目标时用能力标记锁死候选集，
 * 免得认领顺序把断言带偏。
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

// 认领取的是第一个匹配候选，而「无能力要求」的任务对任何 Token 都匹配：
// 上个用例留在待执行里的任务会把本用例的认领抢走。每条用例都从空队列开始。
beforeEach(async () => {
  await clearReadyQueue(t);
});

describe('从需求池到 Agent 看见', () => {
  it('新建任务停在需求池，Agent 的 ready 列表里没有它', async () => {
    const id = await newTask(t, { title: '还没排期' });
    const agent = await issueAgent(t, 'poller-a');

    const ready = await agent.claims.get(`${API}/tasks/ready`);
    expect(ready.status).toBe(200);
    expect(ready.body.items.map((item: { id: string }) => item.id)).not.toContain(id);
    expect(ready.body).toMatchObject({ count: expect.any(Number), limit: expect.any(Number) });
  });

  it('拖到待执行后 ready 列表可见，卡片字段够 Agent 决策', async () => {
    const id = await newTask(t, { title: '待执行可见性', priority: 1, tags: ['支付'] });
    await toReady(t, id);
    const agent = await issueAgent(t, 'poller-b');

    const ready = await agent.claims.get(`${API}/tasks/ready`);
    expect(ready.status).toBe(200);
    const card = ready.body.items.find((item: { id: string }) => item.id === id);
    expect(card).toMatchObject({ id, status: 'READY', priority: 1, type: '需求' });
    expect(card.tags).toEqual(['支付']);
    expect(ready.body.count).toBeGreaterThanOrEqual(1);
  });

  it('能力不匹配的任务既看不见也领不到（20.5 子集判定、验收 40）', async () => {
    const id = await newTask(t, {
      title: '只有 Java 能干',
      required_capabilities: ['language:java', 'tool:maven'],
    });
    await toReady(t, id);
    const goOnly = await issueAgent(t, 'go-only', ['language:go']);
    const javaOnly = await issueAgent(t, 'java-only', ['language:java', 'tool:maven']);

    expect(
      (await goOnly.claims.get(`${API}/tasks/ready`)).body.items.map((i: { id: string }) => i.id),
    ).not.toContain(id);

    // 12 章两个空手而归的 reason：有候选但全被能力挡掉是 all_blocked，队列真空才是 no_ready_task。
    const blocked = await goOnly.claims.post(`${API}/tasks/claim`, {});
    expect(blocked.status).toBe(200);
    expect(blocked.body).toMatchObject({ task: null, reason: 'all_blocked' });

    const claimed = await claimOk(javaOnly, id);
    expect(claimed.task.required_capabilities).toEqual(['language:java', 'tool:maven']);
  });
});

describe('认领与租约三元组', () => {
  it('claim 成功返回 task + lease 三元组，任务落 RUNNING', async () => {
    const id = await newTask(t, { title: '支付回调修复' });
    await toReady(t, id);
    const agent = await issueAgent(t, 'claim-ok', ['language:go']);

    const res = await agent.claims.post(`${API}/tasks/claim`, { capabilities: ['language:go'] });
    expect(res.status).toBe(200);
    expect(res.body.task.id).toBe(id);
    expect(res.body.task.status).toBe('RUNNING');
    expect(Object.keys(res.body.lease).sort()).toEqual(
      ['expires_at', 'lease_id', 'run_id', 'ttl_minutes'].sort(),
    );
    expect(res.body.lease.ttl_minutes).toBe(30);
    expect(res.body.lease.run_id).toMatch(/^R-\d+$/);

    const stored = await t.prisma.task.findUniqueOrThrow({ where: { id } });
    expect(stored.status).toBe('RUNNING');
    expect(stored.leaseId).toBe(res.body.lease.lease_id);
    expect(stored.currentRunId).toBe(res.body.lease.run_id);
    expect(stored.claimedAt).not.toBeNull();

    const run = await t.prisma.taskRun.findUniqueOrThrow({ where: { id: res.body.lease.run_id } });
    expect(run).toMatchObject({ taskId: id, status: 'RUNNING', triggerType: 'agent_poll' });
    // 20.8：agent_name 是认领时服务端写的 api_tokens.name 副本，Agent 无从自报。
    expect(run.agentName).toBe('claim-ok');
    expect(run.runNumber).toBe(1);
  });

  it('无可领任务时是 200 + {task:null,reason}，不是 204（12 章）', async () => {
    const agent = await issueAgent(t, 'empty-poller', ['tool:nothing-matches']);
    const res = await agent.claims.post(`${API}/tasks/claim`, {});
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toMatch(/application\/json/);
    expect(res.body.task).toBeNull();
    expect(res.body.reason).toBe('no_ready_task');
    expect(res.body.lease).toBeUndefined();
  });

  it('并发认领同一队列：只有一个成功，另一方零写入，胜出方租约不被覆盖（4.4、验收 11）', async () => {
    const id = await newTask(t, {
      title: '只有一个赢家',
      required_capabilities: ['tool:race'],
    });
    await toReady(t, id);
    const first = await issueAgent(t, 'racer-1', ['tool:race']);
    const second = await issueAgent(t, 'racer-2', ['tool:race']);

    const auditBefore = await t.prisma.auditLog.count();
    const claimsBefore = await t.prisma.auditLog.count({ where: { action: 'run_claim' } });
    const runsBefore = await t.prisma.taskRun.count({ where: { taskId: id } });
    const [a, b] = await Promise.all([
      first.claims.post(`${API}/tasks/claim`, {}),
      second.claims.post(`${API}/tasks/claim`, {}),
    ]);

    const winners = [a, b].filter((res) => res.body.task !== null);
    const losers = [a, b].filter((res) => res.body.task === null);
    expect(winners).toHaveLength(1);
    expect(losers).toHaveLength(1);
    expect(winners[0].status).toBe(200);
    expect(winners[0].body.task.id).toBe(id);
    expect(losers[0].body.reason).toBe('no_ready_task');

    // 该任务至多一条进行中的 Run（uniq_active_run），失败方没有留下第二条执行记录。
    expect(await t.prisma.taskRun.count({ where: { taskId: id } })).toBe(runsBefore + 1);
    expect(
      await t.prisma.taskRun.count({ where: { taskId: id, status: 'RUNNING' } }),
    ).toBe(1);
    expect(
      await t.prisma.auditLog.count({ where: { targetId: winners[0].body.lease.run_id } }),
    ).toBe(1);
    expect(await t.prisma.auditLog.count({ where: { action: 'run_claim' } })).toBe(
      claimsBefore + 1,
    );
    // 落败方的事务整段回滚：连审计行都没多出一条。
    expect(await t.prisma.auditLog.count()).toBe(auditBefore + 1);

    const stored = await t.prisma.task.findUniqueOrThrow({ where: { id } });
    expect(stored.leaseId).toBe(winners[0].body.lease.lease_id);
    expect(stored.status).toBe('RUNNING');
  });

  it('同一 Agent 连续两次认领拿到两个不同任务，可并行独立回写（验收 12）', async () => {
    const left = await newTask(t, { title: '并行一', required_capabilities: ['tool:parallel'] });
    const right = await newTask(t, { title: '并行二', required_capabilities: ['tool:parallel'] });
    await toReady(t, left);
    await toReady(t, right);
    const agent = await issueAgent(t, 'multi-worker', ['tool:parallel']);

    const first = await claimOk(agent);
    const second = await claimOk(agent);
    expect(new Set([first.task_id, second.task_id])).toEqual(new Set([left, right]));
    expect(first.lease_id).not.toBe(second.lease_id);

    const progress = await agent.claims.post(`${API}/tasks/${second.task_id}/progress`, {
      ...triple(second),
      progress: 42,
      message: '并行推进',
    });
    expect(progress.status).toBe(200);
    expect((await taskStatus(t, second.task_id))).toBe('RUNNING');
    expect((await t.prisma.task.findUniqueOrThrow({ where: { id: left } })).status).toBe('RUNNING');
  });
});

describe('心跳续租', () => {
  it('heartbeat 把 lease_expires_at 推后一个完整 TTL，并回心跳间隔', async () => {
    const id = await newTask(t, { title: '需要续命' });
    await toReady(t, id);
    const agent = await issueAgent(t, 'beater');
    const key = triple(await claimOk(agent, id));

    // 把到期时刻先压到 5 分钟后（仍有效），续租应重新推回 30 分钟。
    const shrunk = await shiftLeaseExpiry(t, id, '+5 minutes');
    const beforeMs = Date.parse(`${shrunk}Z`);

    const res = await agent.claims.post(`${API}/tasks/${id}/heartbeat`, key);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      task_id: id,
      run_id: key.run_id,
      lease_id: key.lease_id,
      ttl_minutes: 30,
      heartbeat_interval_seconds: 300,
    });

    const stored = await t.prisma.task.findUniqueOrThrow({ where: { id } });
    const afterMs = Date.parse(`${stored.leaseExpiresAt}Z`);
    expect(Date.parse(res.body.expires_at)).toBe(afterMs);
    // 5 分钟 → 30 分钟：净增 25 分钟，秒级时钟抖动留 1 分钟余量。
    expect(afterMs - beforeMs).toBeGreaterThanOrEqual(24 * 60_000);
    expect(afterMs - beforeMs).toBeLessThanOrEqual(30 * 60_000);
    expect(await taskStatus(t, id)).toBe('RUNNING');
  });

  it('伪造的 lease_id 续不了租：410 LEASE_EXPIRED 且到期时刻不变', async () => {
    const id = await newTask(t, { title: '租约防伪' });
    await toReady(t, id);
    const agent = await issueAgent(t, 'forger');
    const claimed = await claimOk(agent, id);
    const before = (await t.prisma.task.findUniqueOrThrow({ where: { id } })).leaseExpiresAt;

    const res = await agent.claims.post(`${API}/tasks/${id}/heartbeat`, {
      ...triple(claimed),
      lease_id: '00000000-0000-0000-0000-000000000000',
    });
    expect(res.status).toBe(410);
    expect(errorCode(res)).toBe('LEASE_EXPIRED');
    expect(errorMessage(res)).toBe(USER_COPY.leaseExpired);
    expect(res.body.error).toMatchObject({ task_id: id, run_id: claimed.run_id });
    expect((await t.prisma.task.findUniqueOrThrow({ where: { id } })).leaseExpiresAt).toBe(before);
  });
});

describe('进度与日志回写', () => {
  it('progress 写进当前 Run 并原样回显', async () => {
    const id = await newTask(t, { title: '进度回写' });
    await toReady(t, id);
    const agent = await issueAgent(t, 'progressor');
    const key = triple(await claimOk(agent, id));

    const res = await agent.claims.post(`${API}/tasks/${id}/progress`, {
      ...key,
      progress: 60,
      message: '改签名校验',
    });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ task_id: id, run_id: key.run_id, progress: 60, orphaned: false });
    expect(res.body.message).toBe('改签名校验');

    const run = await t.prisma.taskRun.findUniqueOrThrow({ where: { id: key.run_id } });
    expect(run.progress).toBe(60);
    expect(run.progressMsg).toBe('改签名校验');

    const card = await ui.get(`${API}/tasks/${id}`);
    expect(card.body.progress).toBe(60);
    expect(card.body.progress_msg).toBe('改签名校验');
  });

  it('logs 批量追加，只产生 type=log 的评论且作者取自 Token 名（20.8）', async () => {
    const id = await newTask(t, { title: '日志回写' });
    await toReady(t, id);
    const agent = await issueAgent(t, 'logger-bot');
    const key = triple(await claimOk(agent, id));

    const res = await agent.claims.post(`${API}/tasks/${id}/logs`, {
      ...key,
      level: 'info',
      lines: ['开始跑测试', 'go test ./...', '3 passed'],
    });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ accepted: 3, truncated: false, orphaned: false });

    const logs = await ui.get(`${API}/runs/${key.run_id}/logs`);
    expect(logs.body.items.map((item: { content: string }) => item.content)).toEqual([
      '开始跑测试',
      'go test ./...',
      '3 passed',
    ]);
    expect(logs.body.items[0].author_name).toBe('logger-bot');

    // 「评论」Tab 默认只有人写的评论与系统状态变更（13 章读取模型），日志一条都不混进来。
    const comments = await ui.get(`${API}/tasks/${id}/comments`);
    expect(comments.body.items.map((item: { type: string }) => item.type)).not.toContain('log');
    expect(
      comments.body.items.some((item: { content: string }) => item.content.includes('go test')),
    ).toBe(false);

    const rows = await t.prisma.comment.findMany({ where: { taskId: id } });
    expect(rows.every((row) => row.type === 'log' || row.authorType === 'system')).toBe(true);
    expect(rows.filter((row) => row.authorType === 'agent').every((row) => row.type === 'log')).toBe(
      true,
    );
  });

  it('路径 ID 与三元组 task_id 不一致时 422，不静默按其中一个执行', async () => {
    const id = await newTask(t, { title: '路径不一致' });
    await toReady(t, id);
    const agent = await issueAgent(t, 'mixer');
    const key = triple(await claimOk(agent, id));

    const res = await agent.claims.post(`${API}/tasks/${id}/progress`, {
      ...key,
      task_id: 'T-9999',
      progress: 5,
    });
    expect(res.status).toBe(422);
    expect(errorCode(res)).toBe('INVALID_PARAM');
    expect(res.body.error).toMatchObject({ task_id: id, body_task_id: 'T-9999' });
  });
});

describe('完成回写与幂等（验收 7/35）', () => {
  it('complete → 200、任务转待审核、租约清空、current_run_id 保留', async () => {
    const id = await newTask(t, { title: '支付回调修复' });
    await toReady(t, id);
    const agent = await issueAgent(t, 'finisher');
    const key = triple(await claimOk(agent, id));

    const res = await agent.claims.post(`${API}/tasks/${id}/complete`, {
      ...key,
      summary: '修复签名校验逻辑，新增 2 个回归测试',
      artifacts: [
        { type: 'link', uri: 'https://github.com/acme/pay/pull/342', name: 'PR #342' },
      ],
    });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      run_id: key.run_id,
      run_status: 'SUCCESS',
      task_status: 'REVIEW',
      idempotent: false,
      orphaned: false,
    });
    expect(res.body.task.id).toBe(id);

    const stored = await t.prisma.task.findUniqueOrThrow({ where: { id } });
    expect(stored.status).toBe('REVIEW');
    expect(stored.leaseId).toBeNull();
    expect(stored.leaseExpiresAt).toBeNull();
    // 审核表单靠 current_run_id 定位被审的 Run。
    expect(stored.currentRunId).toBe(key.run_id);

    const runs = await ui.get(`${API}/tasks/${id}/runs`);
    expect(runs.body.items).toHaveLength(1);
    expect(runs.body.items[0]).toMatchObject({
      id: key.run_id,
      status: 'SUCCESS',
      summary: '修复签名校验逻辑，新增 2 个回归测试',
    });
    expect(runs.body.items[0].artifacts[0]).toMatchObject({ type: 'link', name: 'PR #342' });

    const detail = await ui.get(`${API}/tasks/${id}`);
    expect(detail.body.status).toBe('REVIEW');
    expect(detail.body.status_label).toBe('待审核');
  });

  it('同 run_id 重放 complete 仍 200 幂等，不新增 Run、不重复通知、摘要不被覆盖', async () => {
    const id = await newTask(t, { title: '重复提交' });
    await toReady(t, id);
    const agent = await issueAgent(t, 'repeater');
    const key = triple(await claimOk(agent, id));

    const first = await agent.claims.post(`${API}/tasks/${id}/complete`, {
      ...key,
      summary: '第一次的结论',
      artifacts: [],
    });
    expect(first.status).toBe(200);
    const notificationsAfterFirst = await t.prisma.notification.count({
      where: { kind: 'review_pending' },
    });

    const replay = await agent.claims.post(`${API}/tasks/${id}/complete`, {
      ...key,
      summary: '重放的第二次',
      artifacts: [{ type: 'link', uri: 'https://example.com/again', name: '重放外链' }],
    });
    expect(replay.status).toBe(200);
    expect(replay.body).toMatchObject({ idempotent: true, task_status: 'REVIEW', run_id: key.run_id });
    expect(replay.body.run_status).toBe('SUCCESS');

    expect(await t.prisma.taskRun.count({ where: { taskId: id } })).toBe(1);
    const run = await t.prisma.taskRun.findUniqueOrThrow({ where: { id: key.run_id } });
    expect(run.summary).toBe('第一次的结论');
    expect(await t.prisma.notification.count({ where: { kind: 'review_pending' } })).toBe(
      notificationsAfterFirst,
    );
    expect(await taskStatus(t, id)).toBe('REVIEW');
  });

  it('complete 引用未上传过的产物 uri → 422，任务停在执行中', async () => {
    const id = await newTask(t, { title: '产物防伪' });
    await toReady(t, id);
    const agent = await issueAgent(t, 'artifex');
    const key = triple(await claimOk(agent, id));

    const res = await agent.claims.post(`${API}/tasks/${id}/complete`, {
      ...key,
      summary: '带一个没上传过的产物',
      artifacts: [{ type: 'diff', uri: 'artifacts/T-1001/R-2001/fake.diff', name: 'x' }],
    });
    expect(res.status).toBe(422);
    expect(errorCode(res)).toBe('VALIDATION_FAILED');
    expect(JSON.stringify(res.body.error.details)).toContain('fake.diff');
    expect(await taskStatus(t, id)).toBe('RUNNING');
  });

  it('fail 上报把任务推入异常/失败并记 agent_reported', async () => {
    const id = await newTask(t, { title: '跑挂了' });
    await toReady(t, id);
    const agent = await issueAgent(t, 'failer');
    const key = triple(await claimOk(agent, id));

    const res = await agent.claims.post(`${API}/tasks/${id}/fail`, {
      ...key,
      error: '依赖服务不可达',
      summary: '重试三次仍失败',
    });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ run_status: 'FAILED', task_status: 'FAILED', orphaned: false });

    const stored = await t.prisma.task.findUniqueOrThrow({ where: { id } });
    expect(stored.status).toBe('FAILED');
    expect(stored.stopReason).toBe('agent_reported');
    expect(stored.leaseId).toBeNull();
    expect((await t.prisma.taskRun.findUniqueOrThrow({ where: { id: key.run_id } })).error).toBe(
      '依赖服务不可达',
    );
  });
});
