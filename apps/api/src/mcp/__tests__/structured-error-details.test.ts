import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { RequestAuth } from '../../auth/auth.scope';
import { createAgentMcpServer } from '../../mcp/mcp.server';
import { createAgentHarness, type AgentHarness } from '../../agent/__tests__/temp-db';

/**
 * B6 回归：isError 结果的 structuredContent 必须把 details（词表可接受值）一并带回。
 *
 * 断过的点：REST 的 422 一直带 `details:[{path:'type',code:'unknown_type',message:'可选：…'}]`；
 * MCP 侧 content[0].text（完整 toBody）也有，但 structuredContent 只给了 {code,message,...context}
 * ——不少客户端只解析 structuredContent 那条通道（见 mcp.server.ts 里的注释），对这类客户端
 * B6 的回显等于没生效，还在试错刷测试数据。这里走真实 Client ↔ Server 内存传输的
 * tools/call 全链路（createAgentMcpServer → toCallToolResult），不另起一层 mock。
 */
let h: AgentHarness;
let client: Client;

/** SDK 的返回类型是 CallToolResult 与兼容体的联合，按 12 章真正用到的三个字段收窄（同 mcp-tools.test.ts）。 */
interface ToolResult {
  content: { type: string; text: string }[];
  structuredContent?: Record<string, unknown>;
  isError?: boolean;
}

async function call(name: string, args: Record<string, unknown> = {}): Promise<ToolResult> {
  return (await client.callTool({ name, arguments: args })) as unknown as ToolResult;
}

beforeAll(async () => {
  h = createAgentHarness();
  const agent: RequestAuth = await h.agent('b6-details-client', []);
  const server = createAgentMcpServer(agent, {
    claims: h.claims,
    leases: h.leases,
    writeback: h.writeback,
    query: h.query,
    skills: h.skills,
    policy: h.policy,
    breakdown: h.breakdown,
    creation: h.creation,
    settings: h.settings,
  });
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  await server.connect(serverSide);
  client = new Client({ name: 'b6-details-test', version: '0.0.0' });
  await client.connect(clientSide);
});

afterAll(async () => {
  await client?.close().catch(() => undefined);
  await h?.dispose();
});

describe('B6：isError 的 structuredContent 追加 details（可接受值回显）', () => {
  it('board.create_task 传错词表值：structuredContent 带「可选：…」三元组，code/message 原样在位', async () => {
    const result = await call('board.create_task', {
      title: 'B6 回显用例',
      type: 'TODO',
      session_id: 'b6-details-session',
    });

    expect(result.isError).toBe(true);
    const structured = result.structuredContent!;
    // 12 章契约不变：code/message 承载同一份 13 章错误码，原样在位。
    expect(structured.code).toBe('VALIDATION_FAILED');
    expect(structured.message).toBe('任务类型「TODO」不在词表内');
    // B6 核心：只解析 structuredContent 通道的客户端也能一次拿到可接受值。
    const details = structured.details as { path: string; code: string; message: string }[];
    expect(Array.isArray(details)).toBe(true);
    expect(details).toEqual([
      { path: 'type', code: 'unknown_type', message: expect.stringContaining('可选：') },
    ]);
    // 缺省词表五类都在回显里（agent 据此直接改对，不再试错）。
    for (const t of ['需求', '缺陷', '子任务', '巡检', '重构']) {
      expect(details[0]!.message).toContain(t);
    }
    // 双通道同源：content[0] 是完整 toBody 体，其 error 与本例（无 context 键）的
    // structuredContent 完全一致——追加 details 后两条通道不再各说各话。
    expect(JSON.parse(result.content[0]!.text).error).toEqual(structured);
    // 校验失败没有副作用：没建出任务。
    expect(await h.prisma.task.count()).toBe(0);
  });

  it('向后兼容：无 details 的错误不造 details 键，context 现有键原样在位', async () => {
    const result = await call('complete_task', {
      task_id: 'T-1',
      run_id: 'R-999',
      lease_id: '01947c3e-6f2a-7a11-9c31-8d5f2e1b7c40',
      summary: '没认领就想回写',
    });

    expect(result.isError).toBe(true);
    const structured = result.structuredContent!;
    // code/message + ...context（task_id/run_id）与改动前逐键一致。
    expect(structured).toMatchObject({ code: 'TASK_GONE', task_id: 'T-1', run_id: 'R-999' });
    expect('details' in structured).toBe(false);
  });
});
