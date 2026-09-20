import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { RequestAuth } from '../../auth/auth.scope';
import { buildAgentTools } from '../../mcp/agent-tools';
import { callAgentTool, createAgentMcpServer, MCP_SERVER_NAME } from '../../mcp/mcp.server';
import { skillCreateSchema, type SkillCreateInput, type SkillOrigin } from '../../skills/skills.dto';
import { createAgentHarness, seedTask, type AgentHarness } from './temp-db';

/**
 * MCP 侧只测「工具面」：名字集合、tools/list 的入参 schema、以及 12 章通用契约要求的
 * `isError: true` + `structuredContent.code`。业务分支已在 writeback.test.ts 覆盖，
 * 这里走一遍真实的 Client ↔ Server 内存传输，确保 SDK 的参数校验与我们的错误载荷没被架空。
 */
let h: AgentHarness;
let agent: RequestAuth;
let client: Client;

/**
 * §12 + §16.1 W6 已落地子集（9 基础 + block_task + wait_for_resume + 技能三工具）；
 * 策略二工具、`board.*` 全套分别在后续切片补齐（拆解/创建归 W7/W8）。
 * 顺序不敏感但一条都不能多、不能少。
 */
const W6_TOOL_NAMES = [
  'append_log',
  'block_task',
  'claim_next_task',
  'complete_task',
  'fail_task',
  'get_review_feedback',
  'get_skill',
  'get_task',
  'heartbeat',
  'list_ready_tasks',
  'list_skills',
  'search_skills',
  'update_progress',
  'wait_for_resume',
];

beforeAll(async () => {
  h = createAgentHarness();
  agent = await h.agent('mcp-client', ['tool:git']);

  const server = createAgentMcpServer(agent, {
    claims: h.claims,
    leases: h.leases,
    writeback: h.writeback,
    query: h.query,
    skills: h.skills,
  });
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  await server.connect(serverSide);
  client = new Client({ name: 'test-client', version: '0.0.0' });
  await client.connect(clientSide);
});

afterAll(async () => {
  await client?.close().catch(() => undefined);
  await h.dispose();
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

/** SDK 的返回类型是 CallToolResult 与兼容体的联合，这里按 12 章真正用到的三个字段收窄。 */
interface ToolResult {
  content: { type: string; text: string }[];
  structuredContent?: Record<string, unknown>;
  isError?: boolean;
}

async function call(name: string, args: Record<string, unknown> = {}): Promise<ToolResult> {
  return (await client.callTool({ name, arguments: args })) as unknown as ToolResult;
}

function structured(result: ToolResult) {
  return result.structuredContent;
}

describe('MCP 工具面', () => {
  it('tools/list 暴露 12 章基础工具与 W6 技能三工具且都带 JSON Schema', async () => {
    const { tools } = await client.listTools();
    expect(tools.map((tool) => tool.name).sort()).toEqual(W6_TOOL_NAMES);
    expect(MCP_SERVER_NAME).toBe('agent-task-board');
    for (const tool of tools) {
      expect(tool.description).toBeTruthy();
      expect(tool.inputSchema.type).toBe('object');
    }
    const claim = tools.find((tool) => tool.name === 'claim_next_task');
    expect(Object.keys(claim?.inputSchema.properties ?? {})).toEqual(['capabilities', 'task_types']);
    const complete = tools.find((tool) => tool.name === 'complete_task');
    expect(Object.keys(complete?.inputSchema.properties ?? {}).sort()).toEqual([
      'artifacts',
      'lease_id',
      'output',
      'run_id',
      'summary',
      'task_id',
    ]);
  });

  it('claim_next_task 经 MCP 返回 task + lease，并真的建立租约', async () => {
    await seedTask(h.prisma, 'T-1');
    const result = await call('claim_next_task');

    const payload = structured(result)!;
    expect(result.isError).toBeUndefined();
    expect((payload.task as { id: string }).id).toBe('T-1');
    const lease = payload.lease as { run_id: string; lease_id: string; expires_at: string };
    expect(lease.run_id).toMatch(/^R-\d+$/);
    expect((await h.prisma.task.findUniqueOrThrow({ where: { id: 'T-1' } })).leaseId).toBe(
      lease.lease_id,
    );
  });

  it('写回错误以 isError + structuredContent.code 承载同一份 13 章错误码', async () => {
    const error = await call('complete_task', {
      task_id: 'T-1',
      run_id: 'R-999',
      lease_id: '01947c3e-6f2a-7a11-9c31-8d5f2e1b7c40',
      summary: '没认领就想回写',
    });

    expect(error.isError).toBe(true);
    expect(structured(error)).toMatchObject({ code: 'TASK_GONE', task_id: 'T-1', run_id: 'R-999' });
    expect(error.content[0]!.text).toContain('TASK_GONE');
    expect(await h.prisma.taskRun.count()).toBe(0);
  });

  it('三元组校验失败时回 LEASE_EXPIRED 而不是 500', async () => {
    await seedTask(h.prisma, 'T-1');
    const claimed = structured(await call('claim_next_task'))!;
    const lease = claimed.lease as { run_id: string; lease_id: string };

    const result = await call('update_progress', {
      task_id: 'T-1',
      run_id: lease.run_id,
      lease_id: '00000000-0000-4000-8000-000000000000',
      progress: 50,
    });
    expect(result.isError).toBe(true);
    expect(structured(result)!.code).toBe('LEASE_EXPIRED');
    expect((await h.prisma.taskRun.findUniqueOrThrow({ where: { id: lease.run_id } })).progress).toBeNull();
  });

  it('get_review_feedback 与 get_task 是只读工具，不需要三元组', async () => {
    await seedTask(h.prisma, 'T-1');
    const task = await call('get_task', { task_id: 'T-1' });
    expect(structured(task)!.task).toMatchObject({ id: 'T-1', status: 'READY' });

    const feedback = await call('get_review_feedback', { task_id: 'T-1', limit: 3 });
    expect(structured(feedback)).toEqual({ review_feedback: [] });
    expect(await h.prisma.taskRun.count()).toBe(0);
  });

  it('结构不合法的入参在 SDK 层就被挡（协议错误只有 isError，没有 13 章的 code）', async () => {
    const result = await call('heartbeat', { task_id: 'T-1' });

    expect(result.isError).toBe(true);
    expect(result.content[0]!.text).toContain('-32602');
    expect(result.content[0]!.text).toContain('Input validation error');
    // 语义错误（410/409/422）才有 structuredContent.code —— 结构错误到不了我们的 handler。
    expect(result.structuredContent).toBeUndefined();
    expect(await h.prisma.taskRun.count()).toBe(0);
  });

  it('工具表与服务层一一对应：MCP 不复制业务逻辑', () => {
    expect(buildAgentTools({ claims: h.claims, leases: h.leases, writeback: h.writeback, query: h.query, skills: h.skills }).map((tool) => tool.name).sort()).toEqual(
      W6_TOOL_NAMES,
    );
  });

  // ------------------------------------------------------------ v0.0.4 W6 §16.1：block_task / wait_for_resume

  it('block_task 走同一 writeback.blocked：任务转 BLOCKED、租约清空、Run 收口 FAILED', async () => {
    await seedTask(h.prisma, 'T-1');
    const claimed = structured(await call('claim_next_task'))!;
    const lease = claimed.lease as { run_id: string; lease_id: string };

    const blocked = await call('block_task', {
      task_id: 'T-1',
      run_id: lease.run_id,
      lease_id: lease.lease_id,
      block_id: 'h1',
      block_title: '需要产品确认',
      instruction: '请确认字段规则后回 READY',
    });
    expect(structured(blocked)).toMatchObject({
      task_id: 'T-1',
      run_id: lease.run_id,
      task_status: 'BLOCKED',
      idempotent: false,
      orphaned: false,
    });
    const stored = await h.prisma.task.findUniqueOrThrow({ where: { id: 'T-1' } });
    expect([stored.status, stored.leaseId, stored.leaseExpiresAt, stored.currentRunId]).toEqual([
      'BLOCKED',
      null,
      null,
      null,
    ]);
    const run = await h.prisma.taskRun.findUniqueOrThrow({ where: { id: lease.run_id } });
    expect([run.status, run.error]).toEqual(['FAILED', '人工块「需要产品确认」等待人工处理：请确认字段规则后回 READY']);
  });

  it('block_task 需要三元组：非持有租约时回 LEASE_EXPIRED/TASK_GONE', async () => {
    const err = await call('block_task', {
      task_id: 'T-9',
      run_id: 'R-1',
      lease_id: '01947c3e-6f2a-7a11-9c31-8d5f2e1b7c40',
      block_id: 'h1',
      block_title: '',
      instruction: '没认领就想 block',
    });
    expect(err.isError).toBe(true);
    expect(structured(err)!.code).toBe('TASK_GONE');
  });

  it('wait_for_resume 只读：任务非 BLOCKED 时立即回，resumed=false / timed_out=false', async () => {
    await seedTask(h.prisma, 'T-1'); // READY
    const result = await call('wait_for_resume', { task_id: 'T-1', timeout_seconds: 5 });
    expect(structured(result)).toMatchObject({
      task_id: 'T-1',
      status: 'READY',
      resumed: false,
      timed_out: false,
      waited_seconds: 0,
    });
    expect(await h.prisma.taskRun.count()).toBe(0);
  });

  it('wait_for_resume 命中 BLOCKED→READY 的 task.moved 事件即解挂，resumed=true', async () => {
    await seedTask(h.prisma, 'T-1');
    const claimed = structured(await call('claim_next_task'))!;
    const lease = claimed.lease as { run_id: string; lease_id: string };
    await call('block_task', {
      task_id: 'T-1',
      run_id: lease.run_id,
      lease_id: lease.lease_id,
      block_id: 'h1',
      block_title: '人工确认',
      instruction: '等人工',
    });

    // 30ms 后模拟 tasks.service.transition 的 BLOCKED→READY 广播：先落库再 emit，
    // 与生产实现（`setStatus` 先完成，`emit('task.moved')` 后发）同序，避免与 waitResume
    // 里事件唤醒后再读一次的语义打架。
    setTimeout(() => {
      void h.prisma.task
        .update({ where: { id: 'T-1' }, data: { status: 'READY' } })
        .then(() => h.events.emit('task.moved', { id: 'T-1', from: 'BLOCKED', to: 'READY' }));
    }, 30);

    const result = await call('wait_for_resume', { task_id: 'T-1', timeout_seconds: 5 });
    expect(structured(result)).toMatchObject({
      task_id: 'T-1',
      status: 'READY',
      resumed: true,
      timed_out: false,
    });
  });

  it('wait_for_resume 超时未解挂：resumed=false / timed_out=true', async () => {
    await seedTask(h.prisma, 'T-1');
    const claimed = structured(await call('claim_next_task'))!;
    const lease = claimed.lease as { run_id: string; lease_id: string };
    await call('block_task', {
      task_id: 'T-1',
      run_id: lease.run_id,
      lease_id: lease.lease_id,
      block_id: 'h1',
      block_title: '仍待人工',
      instruction: '没人来处理',
    });

    const result = await call('wait_for_resume', { task_id: 'T-1', timeout_seconds: 1 });
    expect(structured(result)).toMatchObject({
      task_id: 'T-1',
      status: 'BLOCKED',
      resumed: false,
      timed_out: true,
    });
  });

  it('wait_for_resume 未知任务：TASK_GONE 而不是 500', async () => {
    const err = await call('wait_for_resume', { task_id: 'T-404', timeout_seconds: 2 });
    expect(err.isError).toBe(true);
    expect(structured(err)).toMatchObject({ code: 'TASK_GONE', task_id: 'T-404' });
  });

  // -------------------------------------------------- v0.0.4 W6 §16.1：技能三工具（list/get/search_skills）

  const skillCtx = () => ({
    claims: h.claims,
    leases: h.leases,
    writeback: h.writeback,
    query: h.query,
    skills: h.skills,
  });
  const ui: RequestAuth = { kind: 'ui' };

  /** 造技能：走 skillCreateSchema.parse 补全默认字段，origin 透传给服务层（W2 三来源）。 */
  async function seedSkill(
    input: Partial<SkillCreateInput> & Pick<SkillCreateInput, 'name'>,
    origin?: SkillOrigin,
  ) {
    return h.skills.create(
      skillCreateSchema.parse({ type: 'prompt', description: '', tags: [], mcp_dependencies: [], ...input }),
      origin,
    );
  }

  it('list_skills 返回 items/total，只读不写库、不建租约', async () => {
    await seedSkill({
      name: '代码审查',
      description: '四步审查',
      tags: ['质量'],
      mcp_dependencies: [{ server: 'github', tools: ['get_pull_request'], required: true }],
    });
    const result = await call('list_skills', {});
    const payload = structured(result)!;
    expect(result.isError).toBeUndefined();
    expect(payload.total).toBe(1);
    const [item] = payload.items as { name: string; readonly: boolean; mcp_dependencies: unknown[] }[];
    expect(item.name).toBe('代码审查');
    expect(item.readonly).toBe(false);
    expect(item.mcp_dependencies).toHaveLength(1);
    expect(await h.prisma.taskRun.count()).toBe(0);
  });

  it('list_skills 按 source 过滤命中三来源（W2 语义）', async () => {
    await seedSkill({ name: '默认巡检' }, 'default');
    await seedSkill({ name: '三方导入' }, 'imported');
    const filtered = structured(await call('list_skills', { source: 'imported' }))!;
    expect(filtered.total).toBe(1);
    expect((filtered.items as { name: string }[])[0]!.name).toBe('三方导入');
  });

  it('get_skill 命中返回详情（含版本历史与依赖），未知 id 回 NOT_FOUND', async () => {
    const created = await seedSkill({ name: '编排技能', type: 'workflow' });
    const ok = structured(await call('get_skill', { skill_id: created.id }))!;
    expect(ok).toMatchObject({ id: created.id, name: '编排技能' });
    expect(Array.isArray((ok as { versions: unknown[] }).versions)).toBe(true);

    const err = await call('get_skill', { skill_id: 'skl_missing' });
    expect(err.isError).toBe(true);
    expect(structured(err)!.code).toBe('NOT_FOUND');
  });

  it('search_skills keyword 必填：空/缺失被 VALIDATION_FAILED 挡下，命中 name/description', async () => {
    await seedSkill({ name: '数据库迁移', description: '执行 schema 变更' });
    const hit = structured(await call('search_skills', { keyword: '迁移' }))!;
    expect((hit as { total: number }).total).toBe(1);

    await expect(callAgentTool(skillCtx(), agent, 'search_skills', { keyword: '' })).rejects.toMatchObject({
      code: 'VALIDATION_FAILED',
    });
  });

  it('技能三工具拒绝 UI 会话 Token（agent 组专属，SKILL 读侧也守作用域）', async () => {
    for (const [name, args] of [
      ['list_skills', {}],
      ['get_skill', { skill_id: 'skl_x' }],
      ['search_skills', { keyword: 'q' }],
    ] as const) {
      await expect(callAgentTool(skillCtx(), ui, name, args)).rejects.toMatchObject({ code: 'FORBIDDEN' });
    }
  });
});
