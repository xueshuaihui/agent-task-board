import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { LATEST_PROTOCOL_VERSION } from '@modelcontextprotocol/sdk/types.js';
import { TASK_PATCH_FIELDS, updateTaskSchema } from '../../contract/agent-schemas';
import {
  createTestApp,
  mcpAccept,
  request,
  type Res,
  type TestApp,
} from '../../__tests__/helpers/http-app';
import {
  API,
  issueAgent,
  newTask,
  uiSender,
  type IssuedAgent,
} from '../../__tests__/helpers/seed';

/**
 * #8 需求级执行规则：用户写面（REST create/PATCH）+ Agent 权限守卫 + 读模型。
 *
 * 口径三句话：
 *  1. 规则只有用户能写：`taskCreateSchema` / `userTaskPatchSchema` 收 `execution_rules`，
 *     `TASK_PATCH_FIELDS`（Agent `update_task` 可写键的派生源）恒不含它；
 *  2. 规则写面与「规则版本时间」同事务落：trim 后为空 = 清空（NULL），清空也刷新时间戳；
 *  3. 读模型分层：详情给全文 + 更新时间，卡片/列表只给 `has_execution_rules` 布尔，
 *     执行记录透出 claim 时冻结的 `rules_snapshot` / `rules_digest`（历史 Run 为 null）。
 *
 * Agent 权限走真 MCP HTTP（initialize → tools/call），守卫在 `WritebackService.updateTask`
 * 的服务层——绕开 MCP 直连也拒；用例顺带锁住「普通子任务改 skills 不被误伤」。
 */
let t: TestApp;
let ui: ReturnType<typeof uiSender>;
let agent: IssuedAgent;
let protocolVersion = '';
let rpcSeq = 0;

interface RpcEnvelope {
  jsonrpc: string;
  id?: number | null;
  result?: unknown;
  error?: { code: number; message: string };
}

interface ToolResult {
  content: { type: string; text: string }[];
  structuredContent?: Record<string, unknown>;
  isError?: boolean;
}

beforeAll(async () => {
  t = await createTestApp();
  ui = uiSender(t);
  agent = await issueAgent(t, 'execution-rules-agent');

  const init = await mcpPost(agent, 'initialize', {
    protocolVersion: LATEST_PROTOCOL_VERSION,
    capabilities: {},
    clientInfo: { name: 'execution-rules-it', version: '0.0.0' },
  });
  expect(init.status).toBe(200);
  protocolVersion = String((init.body.result as { protocolVersion: string }).protocolVersion);
}, 60_000);

afterAll(async () => {
  await t?.close();
});

/** 12 章无状态 Streamable HTTP：每个请求自带 JSON-RPC 信封，initialize 之后带协商版本。 */
async function mcpPost(
  issued: IssuedAgent,
  method: string,
  params?: Record<string, unknown>,
): Promise<Res<RpcEnvelope>> {
  return request(t).post<RpcEnvelope>(
    '/mcp',
    { jsonrpc: '2.0', id: ++rpcSeq, method, ...(params ? { params } : {}) },
    {
      token: issued.token,
      headers: {
        ...mcpAccept(),
        ...(protocolVersion ? { 'mcp-protocol-version': protocolVersion } : {}),
      },
      // MCP 的错误是 result.isError（HTTP 仍 200），不走 13 章 REST 错误体断言。
      skipEnvelopeCheck: true,
    },
  );
}

async function callTool(name: string, args: Record<string, unknown>): Promise<ToolResult> {
  const res = await mcpPost(agent, 'tools/call', { name, arguments: args });
  expect(res.status).toBe(200);
  expect(res.body.error).toBeUndefined();
  return res.body.result as ToolResult;
}

/** 建需求：可以带 `execution_rules`，其余字段吃 schema 默认值。 */
async function createRequirement(body: Record<string, unknown> = {}): Promise<any> {
  const res = await ui.post(`${API}/tasks`, {
    title: `规则需求 ${Math.random().toString(36).slice(2, 8)}`,
    type: '需求',
    ...body,
  });
  expect(res.status, res.text).toBe(201);
  return res.body;
}

async function detail(id: string): Promise<any> {
  const res = await ui.get(`${API}/tasks/${id}`);
  expect(res.status).toBe(200);
  return res.body;
}

async function cardFromBoard(id: string): Promise<any> {
  const res = await ui.get<{ columns: { tasks: any[] }[] }>(`${API}/board`);
  expect(res.status).toBe(200);
  return res.body.columns.flatMap((column) => column.tasks).find((task) => task.id === id);
}

async function cardFromList(id: string): Promise<any> {
  const res = await ui.get<{ items: any[] }>(`${API}/tasks?page_size=200&archived=false`);
  expect(res.status).toBe(200);
  return res.body.items.find((task) => task.id === id);
}

/** nowSql 只到秒：等过下一个整秒，两次 PATCH 的时间戳才必然可区分。 */
async function nextSecond(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 1100 - (Date.now() % 1000)));
}

describe('用户写面：REST 创建需求携带执行规则', () => {
  it('详情返回全文与更新时间；board/list 卡片只给 has_execution_rules=true', async () => {
    const rules = '# 执行规则\n1. 先跑 pnpm test\n2. 只改必要文件\n3. 完成后贴出 diff 摘要';
    const created = await createRequirement({ execution_rules: rules });
    const id = created.id as string;

    const full = await detail(id);
    expect(full.execution_rules).toBe(rules);
    expect(typeof full.execution_rules_updated_at).toBe('string');
    expect(full.execution_rules_updated_at).not.toBe('');
    // 详情本身也带卡片布尔（TaskDetailDto extends TaskCardDto）。
    expect(full.has_execution_rules).toBe(true);

    const boardCard = await cardFromBoard(id);
    expect(boardCard.has_execution_rules).toBe(true);
    // 卡片/列表不背全文：字段根本不该出现。
    expect(boardCard).not.toHaveProperty('execution_rules');

    const listCard = await cardFromList(id);
    expect(listCard.has_execution_rules).toBe(true);
    expect(listCard).not.toHaveProperty('execution_rules');
  });

  it('无规则 / 空串 / 纯空白：规则与时间都为空，卡片布尔 false', async () => {
    const plain = await createRequirement();
    expect((await detail(plain.id)).execution_rules).toBeNull();
    expect((await detail(plain.id)).execution_rules_updated_at).toBeNull();
    expect((await cardFromBoard(plain.id)).has_execution_rules).toBe(false);

    const blank = await createRequirement({ execution_rules: '   \n  ' });
    expect((await detail(blank.id)).execution_rules).toBeNull();
    expect((await detail(blank.id)).execution_rules_updated_at).toBeNull();
    expect((await cardFromBoard(blank.id)).has_execution_rules).toBe(false);
  });
});

describe('用户写面：PATCH 修改 / 清空执行规则', () => {
  it('修改内容并刷新规则版本时间；清空（null）后卡片布尔回到 false', async () => {
    const created = await createRequirement({ execution_rules: '旧规则：只跑单测' });
    const id = created.id as string;
    const firstUpdatedAt = created.execution_rules_updated_at as string;
    expect(firstUpdatedAt).toBeTruthy();

    await nextSecond();
    const patched = await ui.patch(`${API}/tasks/${id}`, {
      execution_rules: '新规则：单测 + typecheck',
    });
    expect(patched.status, patched.text).toBe(200);
    const afterPatch = await detail(id);
    expect(afterPatch.execution_rules).toBe('新规则：单测 + typecheck');
    expect(afterPatch.execution_rules_updated_at).toBeTruthy();
    expect(afterPatch.execution_rules_updated_at).not.toBe(firstUpdatedAt);
    expect((await cardFromBoard(id)).has_execution_rules).toBe(true);

    const cleared = await ui.patch(`${API}/tasks/${id}`, { execution_rules: null });
    expect(cleared.status, cleared.text).toBe(200);
    const afterClear = await detail(id);
    expect(afterClear.execution_rules).toBeNull();
    // 清空也是一次「规则由用户改动」，时间戳仍刷新（不与「从未填过」混为一谈）。
    expect(afterClear.execution_rules_updated_at).toBeTruthy();
    expect(afterClear.execution_rules_updated_at).not.toBe(firstUpdatedAt);
    expect((await cardFromBoard(id)).has_execution_rules).toBe(false);
    expect((await cardFromList(id)).has_execution_rules).toBe(false);
  });

  it('PATCH 只带 execution_rules 一个字段也能通过（不被「没有需要更新的字段」误伤）', async () => {
    const created = await createRequirement();
    const res = await ui.patch(`${API}/tasks/${created.id}`, {
      execution_rules: '唯一改动：补一条规则',
    });
    expect(res.status, res.text).toBe(200);
    expect((await detail(created.id)).execution_rules).toBe('唯一改动：补一条规则');
  });
});

describe('Agent 写面：规则不可写', () => {
  it('TASK_PATCH_FIELDS 不含 execution_rules；updateTaskSchema 对未知键 strict 拒', () => {
    expect(TASK_PATCH_FIELDS).not.toContain('execution_rules');
    const parsed = updateTaskSchema.safeParse({ task_id: 'T-1001', execution_rules: 'x' });
    expect(parsed.success).toBe(false);
    if (!parsed.success) {
      // `.strict()` 的拒径是 unrecognized_keys：未知键名在 issue.keys 里点名（path 为空）。
      const issue = parsed.error.issues.find((item) => item.code === 'unrecognized_keys');
      expect(issue).toBeDefined();
      expect((issue as { keys: string[] }).keys).toContain('execution_rules');
    }
  });

  it('MCP update_task 带 execution_rules：键被协议层剥掉，只剩空 PATCH 被拒', async () => {
    const id = await newTask(t, { title: 'Agent 想改规则', type: '子任务' });
    const result = await callTool('update_task', { task_id: id, execution_rules: '偷偷改规则' });
    expect(result.isError).toBe(true);
    const payload = result.structuredContent as { code: string; message: string };
    expect(payload.code).toBe('VALIDATION_FAILED');
    expect(payload.message).toContain('没有需要更新的字段');
    expect((await detail(id)).execution_rules).toBeNull();
  });
});

describe('Agent 权限守卫：归属 / 需求类型与强制技能', () => {
  it('update_task 带 parent_task_id → 422 forbidden，任务归属保持原样', async () => {
    const parentA = await createRequirement();
    const parentB = await createRequirement();
    const childId = await newTask(t, {
      title: '不许被 Agent 换需求',
      type: '子任务',
      parent_task_id: parentA.id,
    });

    for (const target of [parentB.id, null]) {
      const result = await callTool('update_task', {
        task_id: childId,
        parent_task_id: target,
      });
      expect(result.isError, JSON.stringify(target)).toBe(true);
      const payload = result.structuredContent as {
        code: string;
        message: string;
        details: { path: string; code: string; message: string }[];
      };
      expect(payload.code).toBe('VALIDATION_FAILED');
      expect(payload.message).toContain('归属');
      expect(payload.details).toEqual([
        expect.objectContaining({ path: 'parent_task_id', code: 'forbidden' }),
      ]);
    }

    const stored = await t.prisma.task.findUniqueOrThrow({ where: { id: childId } });
    expect(stored.parentTaskId).toBe(parentA.id as string);
  });

  it('type=需求：改 skills / type 都 422 forbidden；普通子任务改 skills 仍成功', async () => {
    const requirement = await createRequirement();
    const id = requirement.id as string;

    for (const [field, patch] of [
      ['skills', { skills: [] }],
      ['type', { type: '缺陷' }],
    ] as const) {
      const result = await callTool('update_task', { task_id: id, ...patch });
      expect(result.isError, field).toBe(true);
      const payload = result.structuredContent as {
        code: string;
        message: string;
        details: { path: string; code: string }[];
      };
      expect(payload.code, field).toBe('VALIDATION_FAILED');
      expect(payload.message).toContain('需求');
      expect(payload.details).toEqual([expect.objectContaining({ path: field, code: 'forbidden' })]);
    }

    const untouched = await t.prisma.task.findUniqueOrThrow({ where: { id } });
    expect([untouched.type, untouched.skills]).toEqual(['需求', '[]']);

    // 子任务不在守卫范围内：继承场景下 Agent 仍可修正自己的 skills 绑定。
    const childId = await newTask(t, {
      title: '子任务可改技能',
      type: '子任务',
      parent_task_id: id,
    });
    const allowed = await callTool('update_task', { task_id: childId, skills: [] });
    expect(allowed.isError, JSON.stringify(allowed.structuredContent)).toBeUndefined();
    const child = await t.prisma.task.findUniqueOrThrow({ where: { id: childId } });
    expect(child.skills).toBe('[]');
  });
});

describe('执行记录读模型：规则快照与 digest', () => {
  it('GET /tasks/:id/runs 透出解析后的 rules_snapshot 与 rules_digest；历史 Run 为 null', async () => {
    const requirement = await createRequirement({ execution_rules: '领取时冻结我' });
    const id = requirement.id as string;
    const snapshot = {
      requirement_id: id,
      requirement_title: requirement.title,
      execution_rules: '领取时冻结我',
      execution_rules_updated_at: requirement.execution_rules_updated_at,
      skills: [],
    };

    // claim 侧写快照的链路由另一片负责；这里按列契约直接造出「写入后」的形状。
    await t.prisma.$executeRawUnsafe(
      `INSERT INTO task_runs (id, task_id, run_number, status, rules_snapshot, rules_digest)
       VALUES (?, ?, 1, 'RUNNING', ?, ?)`,
      'R-8001',
      id,
      JSON.stringify(snapshot),
      'sha256:rule-digest-1',
    );
    // 历史 Run：两列为 NULL（快照机制上线前的老记录）。
    await t.prisma.$executeRawUnsafe(
      `INSERT INTO task_runs (id, task_id, run_number, status)
       VALUES (?, ?, 2, 'SUCCESS')`,
      'R-8002',
      id,
    );

    const res = await ui.get<{ items: any[] }>(`${API}/tasks/${id}/runs`);
    expect(res.status).toBe(200);
    const withSnapshot = res.body.items.find((run) => run.id === 'R-8001');
    expect(withSnapshot.rules_snapshot).toEqual(snapshot);
    expect(withSnapshot.rules_digest).toBe('sha256:rule-digest-1');

    const historical = res.body.items.find((run) => run.id === 'R-8002');
    expect(historical.rules_snapshot).toBeNull();
    expect(historical.rules_digest).toBeNull();
  });
});
