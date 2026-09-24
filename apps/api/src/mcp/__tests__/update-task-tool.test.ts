import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { RequestAuth } from '../../auth/auth.scope';
import { createAgentMcpServer, callAgentTool, type AgentToolContext } from '../../mcp/mcp.server';
import { createAgentHarness, seedTask, type AgentHarness } from '../../agent/__tests__/temp-db';

/**
 * §16.1 `update_task`（Agent 面全字段 PATCH）的守卫三支回归。
 *
 * 走真实 Client ↔ Server 内存传输的 `tools/call` 全链路（同 structured-error-details.test.ts
 * 的口径）：守卫在 `WritebackService.updateTask`，把它 mock 掉就等于什么都没测。
 * 字段级校验不在这里重测——那套规则只有 `TasksService.applyPatch` 一份实现，REST 侧的
 * 既有用例（state-machine / parent-tasks / skills 绑定）已经在锁它；这里锁的是
 * 「谁能改、改不到什么、被拒时回显什么」，以及 MCP 与 REST 拿到的是同一份 422。
 */
let h: AgentHarness;
let agent: RequestAuth;
let client: Client;
/** 同一个 ctx：既拿来建 server（通道一），也直接 callAgentTool（通道二，绕过 SDK 的参数剥离）。 */
let toolCtx: AgentToolContext;

interface ToolResult {
  content: { type: string; text: string }[];
  structuredContent?: Record<string, unknown>;
  isError?: boolean;
}

async function call(name: string, args: Record<string, unknown> = {}): Promise<ToolResult> {
  return (await client.callTool({ name, arguments: args })) as unknown as ToolResult;
}

function structured(result: ToolResult) {
  return result.structuredContent!;
}

/** 认领 → 拿三元组：RUNNING 支的用例都从真租约出发，不手工拼库。 */
async function claimRunning(id: string) {
  await seedTask(h.prisma, id);
  const claimed = structured(await call('claim_next_task', { capabilities: [] }));
  const lease = claimed.lease as { run_id: string; lease_id: string };
  expect((claimed.task as { id: string }).id).toBe(id);
  return lease;
}

beforeAll(async () => {
  h = createAgentHarness();
  agent = await h.agent('update-task-client', []);
  toolCtx = {
    claims: h.claims,
    leases: h.leases,
    writeback: h.writeback,
    query: h.query,
    skills: h.skills,
    policy: h.policy,
    breakdown: h.breakdown,
    creation: h.creation,
    settings: h.settings,
  };
  const server = createAgentMcpServer(agent, toolCtx);
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  await server.connect(serverSide);
  client = new Client({ name: 'update-task-test', version: '0.0.0' });
  await client.connect(clientSide);
});

afterAll(async () => {
  await client?.close().catch(() => undefined);
  await h?.dispose();
});

beforeEach(async () => {
  await h.prisma.artifact.deleteMany();
  await h.prisma.notification.deleteMany();
  await h.prisma.auditLog.deleteMany();
  await h.prisma.comment.deleteMany();
  await h.prisma.taskRun.deleteMany();
  await h.prisma.task.deleteMany();
  await h.prisma.skillVersion.deleteMany();
  await h.prisma.skill.deleteMany();
});

describe('update_task 守卫第一支：RUNNING 必须持当前租约', () => {
  it('三元组有效 → 改成功：title/priority 落库、返回体是新值，租约与状态原样不动', async () => {
    const lease = await claimRunning('T-run-ok');

    const result = await call('update_task', {
      task_id: 'T-run-ok',
      run_id: lease.run_id,
      lease_id: lease.lease_id,
      title: '执行中改标题',
      priority: 0,
    });

    expect(result.isError).toBeUndefined();
    const payload = structured(result);
    // 返回体就是新的任务详情（getDetail 同源），agent 不用再查一次 get_task。
    expect([payload.id, payload.title, payload.priority, payload.status]).toEqual([
      'T-run-ok',
      '执行中改标题',
      0,
      'RUNNING',
    ]);
    const stored = await h.prisma.task.findUniqueOrThrow({ where: { id: 'T-run-ok' } });
    expect([stored.title, stored.priority, stored.status]).toEqual(['执行中改标题', 0, 'RUNNING']);
    // 编辑不动执行权：租约三列与 current_run_id 保持认领时的值。
    expect([stored.leaseId, stored.currentRunId, stored.leaseRevokedAt]).toEqual([
      lease.lease_id,
      lease.run_id,
      null,
    ]);
  });

  it('守卫放行后仍走既有审计/事件通道，且 actor 是 agent + 凭证名', async () => {
    const lease = await claimRunning('T-run-audit');
    await call('update_task', {
      task_id: 'T-run-audit',
      run_id: lease.run_id,
      lease_id: lease.lease_id,
      tags: ['执行中标'],
    });

    const audit = await h.prisma.auditLog.findFirstOrThrow({
      where: { action: 'task_update', targetId: 'T-run-audit' },
    });
    expect([audit.actorType, audit.actorName]).toEqual(['agent', 'update-task-client']);
    expect(JSON.parse(audit.after as string)).toEqual({ tags: ['执行中标'] });
    expect(h.emitted.filter((e) => e.event === 'task.updated' && e.data.id === 'T-run-audit').length)
      .toBeGreaterThan(0);
  });

  it('缺 run_id/lease_id → 422 且回显该带什么（没到服务层就拒，不猜租约）', async () => {
    const lease = await claimRunning('T-run-missing');

    const result = await call('update_task', { task_id: 'T-run-missing', title: '没带租约' });

    expect(result.isError).toBe(true);
    const payload = structured(result);
    expect(payload.code).toBe('VALIDATION_FAILED');
    expect(payload.message).toContain('run_id');
    expect(payload.message).toContain('lease_id');
    // 直接指名当前 run，agent 不必再去查一遍。
    expect(payload.current_run_id).toBe(lease.run_id);
    const details = payload.details as { path: string; code: string }[];
    expect(details.map((item) => item.path)).toEqual(['run_id', 'lease_id']);
    expect((await h.prisma.task.findUniqueOrThrow({ where: { id: 'T-run-missing' } })).title).not.toBe(
      '没带租约',
    );
  });

  it('错 lease_id → 410 LEASE_EXPIRED（沿用 update_progress 同一份 leases.verify 语义，不另造规则）', async () => {
    const lease = await claimRunning('T-run-bad');

    const result = await call('update_task', {
      task_id: 'T-run-bad',
      run_id: lease.run_id,
      lease_id: randomUUID(),
      title: '拿错租约改',
    });

    expect(result.isError).toBe(true);
    const payload = structured(result);
    expect(payload.code).toBe('LEASE_EXPIRED');
    expect(payload.task_id).toBe('T-run-bad');
    expect(payload.run_id).toBe(lease.run_id);
    expect((await h.prisma.task.findUniqueOrThrow({ where: { id: 'T-run-bad' } })).title).not.toBe(
      '拿错租约改',
    );
  });

  it('错 run_id（真租约 + 别人/别的 Run）→ 410，且任务不落库', async () => {
    const lease = await claimRunning('T-run-a');
    const other = structured(await call('update_task', {
      task_id: 'T-run-a',
      run_id: 'R-9999',
      lease_id: lease.lease_id,
      title: '越界 run',
    }));
    expect(other.code).toBe('LEASE_EXPIRED');
    expect(other.run_id).toBe('R-9999');
    expect((await h.prisma.task.findUniqueOrThrow({ where: { id: 'T-run-a' } })).title).not.toBe(
      '越界 run',
    );
  });
});

describe('update_task 守卫第二支：BACKLOG / READY 免租约可改', () => {
  it('需求池里的子任务：不带 run_id/lease_id 也能改标题、优先级、标签', async () => {
    await seedTask(h.prisma, 'T-backlog', { status: 'BACKLOG', type: '子任务' });

    const result = await call('update_task', {
      task_id: 'T-backlog',
      title: '拆解结果修正后的标题',
      priority: 1,
      tags: ['重构', 'P1'],
    });

    expect(result.isError).toBeUndefined();
    const payload = structured(result);
    expect([payload.title, payload.priority, payload.tags]).toEqual([
      '拆解结果修正后的标题',
      1,
      ['重构', 'P1'],
    ]);
    const stored = await h.prisma.task.findUniqueOrThrow({ where: { id: 'T-backlog' } });
    expect([stored.status, stored.title, stored.priority, stored.tags]).toEqual([
      'BACKLOG',
      '拆解结果修正后的标题',
      1,
      JSON.stringify(['重构', 'P1']),
    ]);
  });

  it('待执行（READY）同样免租约，并只改提交了的字段（未提交的 description 原样）', async () => {
    await seedTask(h.prisma, 'T-ready', { status: 'READY', description: '原始描述' });

    const payload = structured(
      await call('update_task', { task_id: 'T-ready', pinned: true }),
    );
    expect([payload.pinned, payload.description]).toEqual([true, '原始描述']);
  });
});

describe('update_task 守卫第三支：BLOCKED / REVIEW / DONE / FAILED 拒并指名链路', () => {
  it.each([
    ['BLOCKED', 'manual_resume'],
    ['REVIEW', 'review_form'],
    ['DONE', 'new_task'],
    ['FAILED', 'reopen_and_reclaim'],
  ] as const)('%s → 409 TASK_NOT_EDITABLE，details 与 context 都写明下一步', async (status, route) => {
    await seedTask(h.prisma, `T-${status.toLowerCase()}`, { status });

    const result = await call('update_task', { task_id: `T-${status.toLowerCase()}`, title: '终态改标题' });

    expect(result.isError).toBe(true);
    const payload = structured(result);
    expect(payload.code).toBe('TASK_NOT_EDITABLE');
    expect(payload.status).toBe(status);
    expect(payload.route).toBe(route);
    const details = payload.details as { path: string; code: string; message: string }[];
    expect(details[0]).toMatchObject({ path: 'status', code: 'not_editable' });
    // 一次改对：文案里既有「可编辑的是哪两个状态」，也有该状态自己的出口链路。
    expect(details[0].message).toContain('BACKLOG/READY');
    expect((payload.message as string) + details[0].message).toContain(
      {
        BLOCKED: 'wait_for_resume',
        REVIEW: '审核',
        DONE: '终态',
        FAILED: 'claim_next_task',
      }[status],
    );
    expect(
      (await h.prisma.task.findUniqueOrThrow({ where: { id: `T-${status.toLowerCase()}` } })).title,
    ).not.toBe('终态改标题');
  });

  it('BLOCKED 不可能有有效租约（block_task 已清空租约）：带旧三元组同样按第三支拒', async () => {
    const lease = await claimRunning('T-blocked-chain');
    await call('block_task', {
      task_id: 'T-blocked-chain',
      run_id: lease.run_id,
      lease_id: lease.lease_id,
      block_id: 'h1',
      instruction: '请人工确认',
    });

    const result = await call('update_task', {
      task_id: 'T-blocked-chain',
      run_id: lease.run_id,
      lease_id: lease.lease_id,
      title: '阻塞中改标题',
    });
    expect(structured(result).code).toBe('TASK_NOT_EDITABLE');
    expect(structured(result).route).toBe('manual_resume');
  });
});

describe('update_task 的校验复用与越权面', () => {
  it('type 传词表外的值：422 的 details 与 REST 逐字一致（同一份 TasksService 校验，含「可选：…」全量词表）', async () => {
    await seedTask(h.prisma, 'T-type', { status: 'BACKLOG' });

    const result = await call('update_task', { task_id: 'T-type', type: 'TODO' });
    expect(result.isError).toBe(true);
    const payload = structured(result);
    expect(payload.code).toBe('VALIDATION_FAILED');
    expect(payload.message).toBe('任务类型「TODO」不在词表内');
    const details = payload.details as { path: string; code: string; message: string }[];
    expect(details).toEqual([
      { path: 'type', code: 'unknown_type', message: expect.stringContaining('可选：') },
    ]);
    for (const t of ['需求', '缺陷', '子任务', '巡检', '重构']) {
      expect(details[0]!.message).toContain(t);
    }

    // 同一条 REST 路径给出的 details 必须一模一样：MCP 侧没有第二套校验。
    const restError = await h.tasks.patch('T-type', { type: 'TODO' as never }).catch((error) => error);
    expect(restError.details).toEqual(details);

    // content[0] 的 toBody 与 structuredContent 双通道同源（B6 的 c3fa31e 口径，不许回退）。
    expect(JSON.parse(result.content[0]!.text).error).toEqual(payload);
  });

  it('一个可写字段都没给 → 拒（空 PATCH 不改 updatedAt）', async () => {
    await seedTask(h.prisma, 'T-empty', { status: 'READY', title: '原标题' });
    const before = await h.prisma.task.findUniqueOrThrow({ where: { id: 'T-empty' } });

    const result = await call('update_task', { task_id: 'T-empty' });
    expect(result.isError).toBe(true);
    const payload = structured(result);
    expect(payload.code).toBe('VALIDATION_FAILED');
    expect(payload.message).toContain('没有需要更新的字段');

    const after = await h.prisma.task.findUniqueOrThrow({ where: { id: 'T-empty' } });
    expect([after.title, after.updatedAt]).toEqual([before.title, before.updatedAt]);
  });

  it('只带 run_id/lease_id 不带可写字段同样被拒：租约列不是「改动」', async () => {
    const lease = await claimRunning('T-triple-only');
    const result = await call('update_task', {
      task_id: 'T-triple-only',
      run_id: lease.run_id,
      lease_id: lease.lease_id,
    });
    expect(structured(result).code).toBe('VALIDATION_FAILED');
  });

  it('越权面写不进来：status / assignee / 租约列都不在可写字段里（协议层剥掉、schema 层 422，两条通道都改不到）', async () => {
    const lease = await claimRunning('T-escalate');
    const forbidden = [
      { status: 'DONE' },
      { assignee: 'other-agent' },
      { current_run_id: 'R-9' },
      { lease_expires_at: '2999-01-01 00:00:00' },
    ];

    // 通道一：tools/call 全链路。MCP SDK 在进 handler 前就按 inputSchema 剥掉了未声明键
    // （未知键到不了我们手里），所以这五个键一个都写不进库——不报错，但也绝生效。
    for (const extra of forbidden) {
      const result = await call('update_task', {
        task_id: 'T-escalate',
        run_id: lease.run_id,
        lease_id: lease.lease_id,
        ...extra,
      });
      // 只带越权键时会被「至少一个可写字段」的 refine 挡住（剥完就空了）。
      expect(result.isError, JSON.stringify(extra)).toBe(true);
      expect(structured(result).code, JSON.stringify(extra)).toBe('VALIDATION_FAILED');
      expect(structured(result).message).toContain('没有需要更新的字段');
    }
    const stored = await h.prisma.task.findUniqueOrThrow({ where: { id: 'T-escalate' } });
    expect([stored.status, stored.title, stored.leaseId, stored.currentRunId, stored.leaseExpiresAt]).toEqual([
      'RUNNING',
      'T-escalate 标题',
      lease.lease_id,
      lease.run_id,
      stored.leaseExpiresAt,
    ]);

    // 通道二：脱离 HTTP 的直接调用（脚本/诊断走 callAgentTool）没有 SDK 那层剥离，
    // 由 updateTaskSchema 的 `.strict()` 硬拒，并点名未知字段（B6 的回显口径）。
    for (const extra of forbidden) {
      const key = Object.keys(extra)[0]!;
      await expect(
        callAgentTool(toolCtx, agent, 'update_task', {
          task_id: 'T-escalate',
          run_id: lease.run_id,
          title: '顺手越权',
          ...extra,
        }),
      ).rejects.toMatchObject({ code: 'VALIDATION_FAILED', message: expect.stringContaining(key) });
    }
    const after = await h.prisma.task.findUniqueOrThrow({ where: { id: 'T-escalate' } });
    expect([after.status, after.title]).toEqual(['RUNNING', 'T-escalate 标题']);
  });

  it('REST 入口的红线没动：同一个 RUNNING 任务走 patch() 仍是 409 TASK_RUNNING', async () => {
    await claimRunning('T-rest-red-line');
    await expect(h.tasks.patch('T-rest-red-line', { title: 'UI 侧改' })).rejects.toMatchObject({
      code: 'TASK_RUNNING',
      message: '执行中的任务不可编辑，请先强制停止',
    });
    expect((await h.prisma.task.findUniqueOrThrow({ where: { id: 'T-rest-red-line' } })).title).toBe(
      'T-rest-red-line 标题',
    );
  });
});
