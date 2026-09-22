import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { LATEST_PROTOCOL_VERSION, SUPPORTED_PROTOCOL_VERSIONS } from '@modelcontextprotocol/sdk/types.js';
import { appVersion } from '../common/version';
import { USER_COPY } from '../contract/errors';
import { toIso } from '../contract/time';
import { MCP_SERVER_NAME, MCP_WAKE_EXIT, MCP_WAKE_WORD } from '../mcp/mcp.server';
import {
  createTestApp,
  errorCode,
  errorMessage,
  mcpAccept,
  request,
  type Res,
  type TestApp,
} from './helpers/http-app';
import {
  API,
  clearReadyQueue,
  issueAgent,
  newTask,
  shiftLeaseExpiry,
  taskIn,
  taskStatus,
  toReady,
  triple,
  uiSender,
  type Fixture,
  type IssuedAgent,
  type Lease,
} from './helpers/seed';

/**
 * MCP HTTP 通道的端到端覆盖。
 *
 * 与 `agent/__tests__/mcp-tools.test.ts` 的分工：那份走 InMemoryTransport 直接驱动 server 对象，
 * 只测「工具面」；这里测的是那条从没被跑过的路——真 HTTP、真守卫、真前缀（`/mcp` 不在
 * `api/v1` 下）、真无状态 Streamable HTTP 传输。18 章验收 5/20 说的就是这条路：
 * 「Agent 配置 MCP URL 后领取任务」，光有内存传输的用例不足以说它能用。
 *
 * 主链路那组用例故意按协议顺序串行（一个 describe 一条不可拆的往返），共享 taskId / lease：
 * 拆成独立用例就只剩「某个请求返回了 200」，链路断在哪儿反而看不出来。
 */

/**
 * §12 + §16.1 已落地子集（9 基础 + block_task + wait_for_resume + 技能三工具 + 策略二工具
 * + W7 board.* 拆解五工具 + W8-a2 创建闭环三工具 create_task/get_creation_status/wait_for_confirmation）。
 * 与内存传输那份各写一份是有意的：两边都得独立对表，不互相引用。
 */
const CHAPTER_12_TOOLS = [
  'append_log',
  'block_task',
  'board.begin_breakdown',
  'board.cancel_breakdown',
  'board.create_task',
  'board.create_tasks_batch',
  'board.finish_breakdown',
  'board.get_creation_status',
  'board.report_progress',
  'board.report_task_draft',
  'board.wait_for_confirmation',
  'check_mcp_policy',
  'claim_next_task',
  'complete_task',
  'fail_task',
  'get_review_feedback',
  'get_skill',
  'get_task',
  'heartbeat',
  'list_ready_tasks',
  'list_skills',
  'report_mcp_call',
  'search_skills',
  'update_progress',
  'wait_for_resume',
];

let t: TestApp;
let ui: ReturnType<typeof uiSender>;
let http: ReturnType<typeof request>;
let agent: IssuedAgent;
let taskId: string;
let lease: Lease;

let seq = 0;
// initialize 之后的请求都要带协商出来的版本（12 章 Streamable HTTP）；握手本身不带。
let negotiated = '';
const mcpTexts: string[] = [];
const issuedTokens: string[] = [];

interface RpcEnvelope {
  jsonrpc: string;
  id?: number | null;
  result?: any;
  error?: { code: number; message: string };
}

/** 12 章 CallToolResult 的实际形状（SDK 的返回类型是几个联合体的超集，这里按用到的收窄）。 */
interface ToolResult {
  content: { type: string; text: string }[];
  structuredContent?: Record<string, unknown>;
  isError?: boolean;
}

async function mcpPost(
  token: string | null,
  payload: Record<string, unknown>,
  headers?: Record<string, string>,
): Promise<Res<RpcEnvelope>> {
  const res = await http.post<RpcEnvelope>('/mcp', payload, {
    token,
    headers: { ...mcpAccept(), ...(negotiated ? { 'mcp-protocol-version': negotiated } : {}), ...headers },
    // JSON-RPC 的错误体不归 13 章的 { error: { code, message } } 管：传输层错误是 -32xxx。
    skipEnvelopeCheck: true,
  });
  mcpTexts.push(res.text);
  return res;
}

function rpc(token: string | null, method: string, params?: Record<string, unknown>) {
  return mcpPost(token, { jsonrpc: '2.0', id: ++seq, method, ...(params ? { params } : {}) });
}

function notify(token: string | null, method: string, params?: Record<string, unknown>) {
  return mcpPost(token, { jsonrpc: '2.0', method, ...(params ? { params } : {}) });
}

function callTool(token: string | null, name: string, args: Record<string, unknown> = {}) {
  return rpc(token, 'tools/call', { name, arguments: args });
}

/** 成功分支：HTTP 200 + JSON-RPC result，载荷同时经 content[0].text 与 structuredContent 两条通道给出。 */
function unwrap(res: Res<RpcEnvelope>, note: string) {
  expect(res.status, `${note} → ${res.text.slice(0, 200)}`).toBe(200);
  expect(res.body.jsonrpc, note).toBe('2.0');
  expect(res.body.id, note).toBeTypeOf('number');
  expect(res.body.error, `${note} → ${res.text.slice(0, 200)}`).toBeUndefined();
  const result = res.body.result as ToolResult;
  expect(result.isError, `${note} → ${JSON.stringify(result)}`).toBeUndefined();
  expect(Array.isArray(result.content), note).toBe(true);
  expect(result.content[0]?.type, note).toBe('text');
  const payload = JSON.parse(result.content[0]!.text) as any;
  // 两条通道给同一份内容，客户端读哪条都不会拿到不同的结论（12 章通用契约）。
  expect(result.structuredContent, note).toEqual(payload);
  return { result, payload };
}

/** 失败分支：12 章把语义错误放在 result 里以 isError 承载，HTTP 层仍然是 200。 */
function unwrapToolError(res: Res<RpcEnvelope>, note: string) {
  expect(res.status, `${note} → ${res.text.slice(0, 200)}`).toBe(200);
  expect(res.body.error, note).toBeUndefined();
  const result = res.body.result as ToolResult;
  expect(result.isError, `${note} → ${JSON.stringify(result)}`).toBe(true);
  return { result, structured: result.structuredContent ?? {}, text: result.content[0]!.text };
}

beforeAll(async () => {
  t = await createTestApp();
  ui = uiSender(t);
  http = request(t);
  await clearReadyQueue(t);
  taskId = await newTask(t, {
    title: 'MCP HTTP 端到端',
    required_capabilities: ['tool:mcp-http'],
    description: '真实 HTTP 上的 initialize → 领取 → 回写',
  });
  await toReady(t, taskId);
  agent = await issueAgent(t, 'mcp-http-worker', ['tool:mcp-http']);
  issuedTokens.push(agent.token, t.uiToken);
}, 60_000);

afterAll(async () => {
  await t?.close();
});

describe('MCP HTTP 主链路', () => {
  it('initialize 回协议版本、capabilities 与 serverInfo，无状态不发 Mcp-Session-Id', async () => {
    const res = await rpc(agent.token, 'initialize', {
      protocolVersion: LATEST_PROTOCOL_VERSION,
      capabilities: { roots: { listChanged: false } },
      clientInfo: { name: 'atb-http-it', version: '0.0.0' },
    });

    expect(res.status).toBe(200);
    // 无状态 + enableJsonResponse：响应是 application/json，不是一条挂着的 SSE 流。
    expect(res.headers.get('content-type')).toMatch(/application\/json/);
    expect(res.headers.get('mcp-session-id')).toBeNull();
    expect(res.body.jsonrpc).toBe('2.0');
    expect(res.body.id).toBeTypeOf('number');
    expect(res.body.error).toBeUndefined();

    negotiated = String(res.body.result.protocolVersion);
    expect(SUPPORTED_PROTOCOL_VERSIONS).toContain(negotiated);
    // 12 章的形态：这是一台 tools-only 的服务端，prompts / resources / completions 都不声明。
    expect(Object.keys(res.body.result.capabilities as object)).toEqual(['tools']);
    expect(appVersion).toMatch(/^\d+\.\d+\.\d+/);
    expect(res.body.result.serverInfo).toMatchObject({ name: MCP_SERVER_NAME, version: appVersion });
    // #46：唤醒词口径经 initialize 的 instructions 下发，缺省模式（20.9 single）即单次措辞。
    expect(String(res.body.result.instructions)).toContain(MCP_WAKE_WORD);
    expect(String(res.body.result.instructions)).toContain('单次模式');
  });

  it('notifications/initialized 回 202 空体', async () => {
    const res = await notify(agent.token, 'notifications/initialized');
    expect(res.status).toBe(202);
    expect(res.text).toBe('');
  });

  it('GET 与 DELETE /mcp 在无状态模式下回 405 而不是 404', async () => {
    for (const method of ['GET', 'DELETE'] as const) {
      const res = await http.send<RpcEnvelope>('/mcp', {
        method,
        token: agent.token,
        headers: { ...mcpAccept(), 'mcp-protocol-version': negotiated },
        skipEnvelopeCheck: true,
      });
      mcpTexts.push(res.text);
      expect(res.status, method).toBe(405);
      expect(res.body.error?.code, method).toBe(-32000);
      expect(res.body.error?.message, method).toContain('无状态');
    }
  });

  it('tools/list 列出 12 章基础工具与 W6 技能三工具，每个都带 description 与 inputSchema', async () => {
    const res = await rpc(agent.token, 'tools/list', {});
    expect(res.status).toBe(200);
    const tools = res.body.result.tools as { name: string; description?: string; inputSchema?: any }[];
    expect(tools.map((tool) => tool.name).sort()).toEqual(CHAPTER_12_TOOLS);
    expect(res.body.result.nextCursor).toBeUndefined();

    for (const tool of tools) {
      expect(tool.description, tool.name).toBeTruthy();
      expect(tool.inputSchema?.type, tool.name).toBe('object');
      expect(tool.inputSchema?.properties, tool.name).toBeTypeOf('object');
    }
    // 写回侧的三元组在 schema 里就是必填：少一个凭据的调用到不了服务层。
    const complete = tools.find((tool) => tool.name === 'complete_task');
    expect(complete?.inputSchema.required).toEqual(
      expect.arrayContaining(['task_id', 'run_id', 'lease_id']),
    );
  });

  it('只声明 tools 能力：未声明的 prompts/list 与 resources/list 回 -32601', async () => {
    // 12 章只有九个工具，没有 prompts/resources。服务端不声明这两项能力，客户端按
    // capabilities 决定要不要调；真调了就得到协议层的 Method not found，而不是空列表。
    for (const method of ['prompts/list', 'resources/list']) {
      const res = await rpc(agent.token, method, {});
      expect(res.status, method).toBe(200);
      expect(res.body.result, method).toBeUndefined();
      expect(res.body.error?.code, method).toBe(-32601);
      expect(res.body.id, method).toBeTypeOf('number');
    }
  });

  it('tools/call claim_next_task 领到任务，三元组与库内一致（验收 5）', async () => {
    const { payload } = unwrap(
      await callTool(agent.token, 'claim_next_task', { capabilities: ['tool:mcp-http'] }),
      'claim_next_task',
    );

    expect(payload.task.id).toBe(taskId);
    expect(payload.task.status).toBe('RUNNING');
    expect(payload.task.required_capabilities).toEqual(['tool:mcp-http']);
    expect(payload.lease.expires_at).toBeTruthy();
    expect(payload.lease.ttl_minutes).toBeGreaterThan(0);

    lease = triple(payload);
    const stored = await t.prisma.task.findUniqueOrThrow({ where: { id: taskId } });
    expect([stored.status, stored.leaseId, stored.currentRunId]).toEqual([
      'RUNNING',
      lease.lease_id,
      lease.run_id,
    ]);

    const run = await t.prisma.taskRun.findUniqueOrThrow({ where: { id: lease.run_id } });
    // agent_name 与 token_id 都是服务端在认领那一刻写下的，Agent 无从自报（20.8）。
    expect({
      taskId: run.taskId,
      leaseId: run.leaseId,
      tokenId: run.tokenId,
      agentName: run.agentName,
      status: run.status,
      runNumber: run.runNumber,
      triggerType: run.triggerType,
    }).toEqual({
      taskId,
      leaseId: lease.lease_id,
      tokenId: agent.id,
      agentName: agent.name,
      status: 'RUNNING',
      runNumber: 1,
      triggerType: 'agent_poll',
    });
  });

  it('MCP 领取真的驱动看板：卡片离开待执行、落进执行中列（验收 6）', async () => {
    const board = await ui.get(`${API}/board`);
    expect(board.status).toBe(200);
    const idsByColumn = new Map<string, string[]>(
      board.body.columns.map((column: { status: string; tasks: { id: string }[] }) => [
        column.status,
        column.tasks.map((card) => card.id),
      ]),
    );
    expect(idsByColumn.get('READY')).not.toContain(taskId);
    const card = idsByColumn.get('RUNNING');
    expect(card).toContain(taskId);

    const detail = await ui.get(`${API}/tasks/${taskId}`);
    expect(detail.body).toMatchObject({
      id: taskId,
      status: 'RUNNING',
      current_run_id: lease.run_id,
      agent_name: agent.name,
    });
  });

  it('tools/call update_progress 写进 Run，详情与看板卡片同步（6.4）', async () => {
    const { payload } = unwrap(
      await callTool(agent.token, 'update_progress', {
        ...triple(lease),
        progress: 35,
        message: '契约校验已跑通',
      }),
      'update_progress',
    );
    expect(payload).toMatchObject({
      task_id: taskId,
      run_id: lease.run_id,
      progress: 35,
      message: '契约校验已跑通',
      orphaned: false,
    });

    const run = await t.prisma.taskRun.findUniqueOrThrow({ where: { id: lease.run_id } });
    expect([run.progress, run.progressMsg]).toEqual([35, '契约校验已跑通']);
    const detail = await ui.get(`${API}/tasks/${taskId}`);
    expect(detail.body).toMatchObject({ progress: 35, progress_msg: '契约校验已跑通' });
    const board = await ui.get(`${API}/board`);
    const card = board.body.columns
      .find((column: { status: string }) => column.status === 'RUNNING')
      .tasks.find((item: { id: string }) => item.id === taskId);
    expect([card.progress, card.progress_msg]).toEqual([35, '契约校验已跑通']);
  });

  it('append_log 只写 type=log 且作者取 Token 名；heartbeat 把到期时刻推后（20.8、十四章步骤 4）', async () => {
    const logs = unwrap(
      await callTool(agent.token, 'append_log', {
        ...triple(lease),
        lines: ['拉取依赖清单', '跑契约校验'],
        level: 'info',
      }),
      'append_log',
    );
    expect(logs.payload).toMatchObject({ task_id: taskId, run_id: lease.run_id, accepted: 2 });

    const rows = await t.prisma.comment.findMany({
      where: { taskId, runId: lease.run_id },
      orderBy: { createdAt: 'asc' },
    });
    expect(rows.map((row) => [row.type, row.authorType, row.authorName, row.content])).toEqual([
      ['log', 'agent', agent.name, '拉取依赖清单'],
      ['log', 'agent', agent.name, '跑契约校验'],
    ]);

    // 把到期时刻改短（仍晚于 now）：直接挪到过去会在 verify 里触发过期回收（4.3.2 表第 3 行），
    // 那次心跳拿到的就是 LEASE_EXPIRED 而不是续租结果。
    const shifted = await shiftLeaseExpiry(t, taskId, '+2 minutes');
    const beat = unwrap(
      await callTool(agent.token, 'heartbeat', { ...triple(lease) }),
      'heartbeat',
    );
    expect(beat.payload).toMatchObject({
      task_id: taskId,
      run_id: lease.run_id,
      lease_id: lease.lease_id,
    });
    expect(beat.payload.heartbeat_interval_seconds).toBeTypeOf('number');
    const stored = await t.prisma.task.findUniqueOrThrow({ where: { id: taskId } });
    expect(stored.leaseExpiresAt! > shifted).toBe(true);
    expect(toIso(stored.leaseExpiresAt)).toBe(beat.payload.expires_at);
  });

  it('tools/call complete_task 后任务进待审核、Run 落 SUCCESS 并产生审核通知（验收 7）', async () => {
    const notesBefore = await t.prisma.notification.count({ where: { kind: 'review_pending' } });
    const { payload } = unwrap(
      await callTool(agent.token, 'complete_task', {
        ...triple(lease),
        summary: 'MCP HTTP 往返完成',
        output: 'all green',
      }),
      'complete_task',
    );
    expect(payload).toMatchObject({
      run_id: lease.run_id,
      run_status: 'SUCCESS',
      task_status: 'REVIEW',
      idempotent: false,
      orphaned: false,
    });
    expect(payload.task).toMatchObject({ id: taskId, status: 'REVIEW' });

    const run = await t.prisma.taskRun.findUniqueOrThrow({ where: { id: lease.run_id } });
    expect([run.status, run.summary, run.output, run.finishedAt !== null]).toEqual([
      'SUCCESS',
      'MCP HTTP 往返完成',
      'all green',
      true,
    ]);
    // 4.3.2：租约随完成清空，current_run_id 保留给审核表单定位被审的 Run。
    const stored = await t.prisma.task.findUniqueOrThrow({ where: { id: taskId } });
    expect([stored.status, stored.leaseId, stored.leaseExpiresAt, stored.currentRunId]).toEqual([
      'REVIEW',
      null,
      null,
      lease.run_id,
    ]);

    expect(await t.prisma.notification.count({ where: { kind: 'review_pending' } })).toBe(
      notesBefore + 1,
    );
    const board = await ui.get(`${API}/board`);
    const review = board.body.columns.find((column: { status: string }) => column.status === 'REVIEW');
    expect(review.tasks.map((card: { id: string }) => card.id)).toContain(taskId);
  });

  it('同一 run 再 complete_task：幂等 200、不多一条 Run、不重复通知（验收 35）', async () => {
    const runsBefore = await t.prisma.taskRun.count({ where: { taskId } });
    const notesBefore = await t.prisma.notification.count({ where: { kind: 'review_pending' } });
    const writebacksBefore = await t.prisma.auditLog.count({ where: { action: 'run_writeback' } });

    const { payload } = unwrap(
      await callTool(agent.token, 'complete_task', { ...triple(lease), summary: '重复提交的那一次' }),
      'replay',
    );
    expect(payload).toMatchObject({
      run_id: lease.run_id,
      task_status: 'REVIEW',
      idempotent: true,
      orphaned: false,
    });

    expect(await t.prisma.taskRun.count({ where: { taskId } })).toBe(runsBefore);
    expect(await t.prisma.notification.count({ where: { kind: 'review_pending' } })).toBe(notesBefore);
    expect(await t.prisma.auditLog.count({ where: { action: 'run_writeback' } })).toBe(
      writebacksBefore,
    );
    // 幂等分支整段短路：连首次的摘要都不被后到的重复提交覆盖。
    expect((await t.prisma.taskRun.findUniqueOrThrow({ where: { id: lease.run_id } })).summary).toBe(
      'MCP HTTP 往返完成',
    );
    expect(await taskStatus(t, taskId)).toBe('REVIEW');
  });

  it('租约失效经 MCP 回 isError + structuredContent.code，与 REST 同一份 13 章错误码', async () => {
    const res = await callTool(agent.token, 'update_progress', {
      task_id: taskId,
      run_id: lease.run_id,
      lease_id: '00000000-0000-4000-8000-000000000000',
      progress: 80,
    });
    const { structured, text } = unwrapToolError(res, '失效租约');
    expect(structured).toMatchObject({
      code: 'LEASE_EXPIRED',
      message: USER_COPY.leaseExpired,
      task_id: taskId,
      run_id: lease.run_id,
    });
    expect(JSON.parse(text).error.code).toBe('LEASE_EXPIRED');
  });
});

describe('MCP HTTP 的鉴权与传输层（验收 32）', () => {
  it('不带 Authorization 的 tools/call 回 401，错误体仍是 13 章形状', async () => {
    const res = await callTool(null, 'claim_next_task', {});
    expect(res.status).toBe(401);
    expect(errorCode(res)).toBe('UNAUTHORIZED');
    expect(errorMessage(res)).toBe('缺少凭证');
  });

  it('随机 Bearer 与空 Bearer 都是 401 凭证无效，不是 403', async () => {
    for (const bearer of ['atb_not_a_real_token_value_', '   ']) {
      const res = await callTool(bearer, 'tools/list', {});
      expect(res.status, bearer).toBe(401);
      expect(errorCode(res)).toBe('UNAUTHORIZED');
    }
  });

  it('UI 会话 Token 打 /mcp 是 403 FORBIDDEN（13 章跨组拒绝在 MCP 侧同样生效）', async () => {
    const res = await callTool(t.uiToken, 'tools/list', {});
    expect(res.status).toBe(403);
    expect(errorCode(res)).toBe('FORBIDDEN');
    expect(errorMessage(res)).toBe('UI 会话 Token 不能调用 Agent 写回接口');
    expect(res.text).not.toContain(t.uiToken);
  });

  it('吊销后的 Agent Token 打 /mcp 回 401，且领不到任务', async () => {
    const temp = await issueAgent(t, 'mcp-revoked');
    issuedTokens.push(temp.token);
    expect((await callTool(temp.token, 'tools/list', {})).status).toBe(200);

    await temp.ui.del(`${API}/tokens/${temp.id}`);
    const after = await callTool(temp.token, 'claim_next_task', {});
    expect(after.status).toBe(401);
    expect(errorCode(after)).toBe('UNAUTHORIZED');
    expect(errorMessage(after)).toBe('Token 已吊销');
  });

  it('Accept 缺 text/event-stream 时被传输层拒 406', async () => {
    const res = await mcpPost(
      agent.token,
      { jsonrpc: '2.0', id: ++seq, method: 'tools/list' },
      { accept: 'application/json' },
    );
    expect(res.status).toBe(406);
    expect(res.body.jsonrpc).toBe('2.0');
    expect(res.body.error?.code).toBe(-32000);
    expect(res.body.error?.message).toContain('text/event-stream');
  });

  it('未知工具名在 MCP 层回 isError，不落到服务层也不产生写入', async () => {
    const runsBefore = await t.prisma.taskRun.count();
    const { result } = unwrapToolError(
      await callTool(agent.token, 'no_such_tool', {}),
      '未知工具',
    );
    expect(result.content[0]!.text).toContain('no_such_tool');
    expect(await t.prisma.taskRun.count()).toBe(runsBefore);
  });

  it('未知方法与不成形的请求体都停在协议层，不落 500', async () => {
    const unknown = await rpc(agent.token, 'bogus/method', {});
    expect(unknown.status).toBe(200);
    expect(unknown.body.error?.code).toBe(-32601);
    expect(unknown.body.result).toBeUndefined();

    const malformed = await mcpPost(agent.token, { jsonrpc: '2.0', id: ++seq });
    expect(malformed.status).toBe(400);
    expect(malformed.body.error?.code).toBe(-32700);
    expect(malformed.body.id).toBeNull();
  });
});

describe('MCP 的缺省入参与 REST 同口径（12 章）', () => {
  it('tools/call 不带 arguments 也领得到任务；缺省 summary 的回写照样进待审核', async () => {
    await clearReadyQueue(t);
    const id = await newTask(t, { title: '零参数认领', required_capabilities: ['tool:mcp-noargs'] });
    await toReady(t, id);
    const worker = await issueAgent(t, 'mcp-noargs', ['tool:mcp-noargs']);
    issuedTokens.push(worker.token);

    // JSON-RPC 侧 `params.arguments` 是可选字段，12 章 claim 的两个入参又都有缺省值，
    // 所以「不带 arguments 的 claim_next_task」是合法请求；REST 侧同一形状（空 body）领得到。
    const claimed = unwrap(
      await rpc(worker.token, 'tools/call', { name: 'claim_next_task', arguments: {} }),
      '零参数认领',
    );
    expect(claimed.payload.task.id).toBe(id);
    const key = triple(claimed.payload);

    const done = unwrap(
      await callTool(worker.token, 'complete_task', { ...triple(key) }),
      '缺省 summary 的回写',
    );
    expect(done.payload).toMatchObject({ task_status: 'REVIEW', idempotent: false });
    const run = await t.prisma.taskRun.findUniqueOrThrow({ where: { id: key.run_id } });
    expect([run.status, run.summary]).toEqual(['SUCCESS', null]);

    // REST 侧的口径参照：空 body 的 claim 只是队列空了，不是「参数非法」。
    const viaRest = await worker.claims.post(`${API}/tasks/claim`, {});
    expect(viaRest.status).toBe(200);
    expect(viaRest.body).toEqual({ task: null, reason: 'no_ready_task' });
  });
});

describe('MCP 入口的入参口径与 REST 一致（验收 43 的 MCP 侧）', () => {
  let fixture: Fixture;

  beforeEach(async () => {
    fixture = await taskIn(t, 'RUNNING', 'MCP 入参口径夹具');
    issuedTokens.push(fixture.agent.token);
  });

  /**
   * 越界值被挡在 SDK 那一道（同一份 contract/agent-schemas.ts 生成的 schema），
   * 所以 envelope 与 REST 的 422 不同：没有 HTTP 状态码，只有 isError。
   * 这里钉的是口径统一的两端——同一份 schema + 零写入，而不是错误体的形状。
   */
  it('append_log 的 level 越出 20.2 枚举被拒，一行日志都没入库', async () => {
    const { result } = unwrapToolError(
      await callTool(fixture.agent.token, 'append_log', {
        ...triple(fixture.key!),
        lines: ['越界尝试'],
        level: 'TRACE',
      }),
      'level 越界',
    );
    expect(result.content[0]!.text).toContain('append_log');
    // 只数 log：夹具造到执行中时已经留了 status_change 行。
    expect(await t.prisma.comment.count({ where: { taskId: fixture.id, type: 'log' } })).toBe(0);
    expect(await taskStatus(t, fixture.id)).toBe('RUNNING');
  });

  it('progress 越界（101 / -1 / 非整数）被拒且不改 Run 进度', async () => {
    for (const bad of [101, -1, 40.5]) {
      const res = await callTool(fixture.agent.token, 'update_progress', {
        ...triple(fixture.key!),
        progress: bad,
      });
      unwrapToolError(res, `progress=${bad}`);
    }
    const run = await t.prisma.taskRun.findUniqueOrThrow({ where: { id: fixture.key!.run_id } });
    expect(run.progress).toBeNull();
  });

  it('artifacts.type 越界与未上传 uri 都被拒，任务停在执行中', async () => {
    const badType = unwrapToolError(
      await callTool(fixture.agent.token, 'complete_task', {
        ...triple(fixture.key!),
        artifacts: [{ type: 'exe', uri: 'payload.bin' }],
      }),
      '产物类型越界',
    );
    expect(badType.result.content[0]!.text).toContain('complete_task');

    // 这一条是服务层 20.6 的校验（schema 之外），拿到的就是 13 章的 code。
    const notUploaded = unwrapToolError(
      await callTool(fixture.agent.token, 'complete_task', {
        ...triple(fixture.key!),
        artifacts: [{ type: 'diff', uri: 'never-uploaded.diff' }],
      }),
      '未上传产物',
    );
    expect(notUploaded.structured.code).toBe('VALIDATION_FAILED');

    expect(await taskStatus(t, fixture.id)).toBe('RUNNING');
    expect(await t.prisma.artifact.count({ where: { taskId: fixture.id } })).toBe(0);
    expect(await t.prisma.taskRun.count({ where: { taskId: fixture.id } })).toBe(1);
  });
});

describe('MCP HTTP 并发认领（验收 11）', () => {
  it('队列只剩一条时两个 Token 同时 claim_next_task，只有一个拿到且落败方零写入', async () => {
    await clearReadyQueue(t);
    const id = await newTask(t, { title: 'MCP 抢占', required_capabilities: ['tool:mcp-race'] });
    await toReady(t, id);
    const left = await issueAgent(t, 'mcp-racer-1', ['tool:mcp-race']);
    const right = await issueAgent(t, 'mcp-racer-2', ['tool:mcp-race']);
    issuedTokens.push(left.token, right.token);

    const auditsBefore = await t.prisma.auditLog.count();
    const [a, b] = await Promise.all([
      callTool(left.token, 'claim_next_task', {}),
      callTool(right.token, 'claim_next_task', {}),
    ]);
    const payloads = [unwrap(a, '并发一').payload, unwrap(b, '并发二').payload];
    const winners = payloads.filter((item) => item.task !== null);
    const losers = payloads.filter((item) => item.task === null);
    expect(winners).toHaveLength(1);
    expect(losers).toHaveLength(1);
    expect(losers[0]).toEqual({ task: null, reason: 'no_ready_task' });

    expect(await t.prisma.taskRun.count({ where: { taskId: id } })).toBe(1);
    // 落败方的事务整段回滚：连审计行都没多出一条。
    expect(await t.prisma.auditLog.count()).toBe(auditsBefore + 1);
    const stored = await t.prisma.task.findUniqueOrThrow({ where: { id } });
    expect([stored.status, stored.leaseId, stored.currentRunId]).toEqual([
      'RUNNING',
      winners[0].lease.lease_id,
      winners[0].lease.run_id,
    ]);
  });
});

describe('真实 MCP 客户端经 HTTP + Token 领取与回写（验收 5/20）', () => {
  it('SDK Client over Streamable HTTP：listTools → claim_next_task → complete_task', async () => {
    await clearReadyQueue(t);
    const id = await newTask(t, { title: 'Claude Code 视角', required_capabilities: ['tool:mcp-sdk'] });
    await toReady(t, id);
    const worker = await issueAgent(t, 'mcp-sdk-client', ['tool:mcp-sdk']);
    issuedTokens.push(worker.token);

    // 与 10.2 的客户端配置同形：一个 url + 一个 Authorization 头，没有别的适配层。
    const transport = new StreamableHTTPClientTransport(new URL(`${t.origin}/mcp`), {
      requestInit: { headers: { authorization: `Bearer ${worker.token}` } },
    });
    const client = new Client({ name: 'atb-sdk-over-http', version: '0.0.0' });
    await client.connect(transport);
    try {
      expect(client.getServerVersion()).toMatchObject({ name: MCP_SERVER_NAME });
      expect(client.getServerCapabilities()).toHaveProperty('tools');

      const listed = await client.listTools();
      expect(listed.tools.map((tool) => tool.name).sort()).toEqual(CHAPTER_12_TOOLS);

      const claimed = (await client.callTool({
        name: 'claim_next_task',
        arguments: { capabilities: ['tool:mcp-sdk'] },
      })) as unknown as ToolResult;
      expect(claimed.isError).toBeUndefined();
      const payload = JSON.parse(claimed.content[0]!.text);
      expect(payload.task.id).toBe(id);

      const done = (await client.callTool({
        name: 'complete_task',
        arguments: { ...triple(payload), summary: 'SDK 客户端的回写' },
      })) as unknown as ToolResult;
      expect(done.isError).toBeUndefined();
      expect(JSON.parse(done.content[0]!.text)).toMatchObject({ task_status: 'REVIEW' });
      expect(await taskStatus(t, id)).toBe('REVIEW');
      expect(await t.prisma.taskRun.count({ where: { taskId: id } })).toBe(1);
    } finally {
      await client.close();
    }
  });
});

describe('贾维斯唤醒模式的热生效（#46）', () => {
  it('mcp_wake_mode 改 continuous 后，新一次 initialize 的 instructions 即连续措辞', async () => {
    const patched = await ui.patch(`${API}/settings`, { mcp_wake_mode: 'continuous' });
    expect(patched.status).toBe(200);
    expect(patched.body.mcp_wake_mode).toBe('continuous');

    const res = await rpc(agent.token, 'initialize', {
      protocolVersion: LATEST_PROTOCOL_VERSION,
      capabilities: {},
      clientInfo: { name: 'atb-wake-mode', version: '0.0.0' },
    });
    expect(res.status).toBe(200);
    const instructions = String(res.body.result.instructions);
    expect(instructions).toContain(MCP_WAKE_WORD);
    expect(instructions).toContain('连续模式');
    expect(instructions).toContain(MCP_WAKE_EXIT);
    expect(instructions).not.toContain('单次模式');

    // 还原缺省：本文件的其余用例与后续文件共用这套约定，不留副作用。
    expect((await ui.patch(`${API}/settings`, { mcp_wake_mode: 'single' })).status).toBe(200);
  });
});

describe('响应不外泄凭证（15 章）', () => {
  it('每一段 /mcp 往返里都没有任何 Token 明文', () => {
    expect(mcpTexts.length).toBeGreaterThan(15);
    for (const token of issuedTokens) {
      expect(token).toBeTruthy();
      for (const text of mcpTexts) expect(text).not.toContain(token);
    }
  });
});
