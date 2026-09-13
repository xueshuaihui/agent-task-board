import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { RequestAuth } from '../../auth/auth.scope';
import { buildAgentTools } from '../../mcp/agent-tools';
import { createAgentMcpServer, MCP_SERVER_NAME } from '../../mcp/mcp.server';
import { createAgentHarness, seedTask, type AgentHarness } from './temp-db';

/**
 * MCP 侧只测「工具面」：名字集合、tools/list 的入参 schema、以及 12 章通用契约要求的
 * `isError: true` + `structuredContent.code`。业务分支已在 writeback.test.ts 覆盖，
 * 这里走一遍真实的 Client ↔ Server 内存传输，确保 SDK 的参数校验与我们的错误载荷没被架空。
 */
let h: AgentHarness;
let agent: RequestAuth;
let client: Client;

/** 12 章工具表的原文清单，顺序不敏感但一条都不能多、不能少。 */
const CHAPTER_12_TOOLS = [
  'append_log',
  'claim_next_task',
  'complete_task',
  'fail_task',
  'get_review_feedback',
  'get_task',
  'heartbeat',
  'list_ready_tasks',
  'update_progress',
];

beforeAll(async () => {
  h = createAgentHarness();
  agent = await h.agent('mcp-client', ['tool:git']);

  const server = createAgentMcpServer(agent, {
    claims: h.claims,
    leases: h.leases,
    writeback: h.writeback,
    query: h.query,
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
  it('tools/list 暴露 12 章的九个工具且都带 JSON Schema', async () => {
    const { tools } = await client.listTools();
    expect(tools.map((tool) => tool.name).sort()).toEqual(CHAPTER_12_TOOLS);
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
    expect(buildAgentTools({ claims: h.claims, leases: h.leases, writeback: h.writeback, query: h.query }).map((tool) => tool.name).sort()).toEqual(
      CHAPTER_12_TOOLS,
    );
  });
});
