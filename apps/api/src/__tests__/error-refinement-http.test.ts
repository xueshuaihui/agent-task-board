import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { LATEST_PROTOCOL_VERSION } from '@modelcontextprotocol/sdk/types.js';
import {
  createTestApp,
  errorCode,
  errorMessage,
  mcpAccept,
  request,
  type Res,
  type Sender,
  type TestApp,
} from './helpers/http-app';
import { API, issueAgent, uiSender, type IssuedAgent } from './helpers/seed';
import { holdExclusiveLock } from './helpers/db-lock-holder';

/**
 * 真 HTTP 面上的「报错细化」出口（2026-09-29 用户口径：报错可以全部细化一下）。
 *
 * 与 `src/contract/__tests__/error-code-table.test.ts` 的分工：那份在函数层面把 REST 过滤器与
 * MCP 出口钉成同一张码表；这里补上从没被跑过的一段——真 Nest 应用、真 Prisma 引擎、真 fetch，
 * 看一条引擎原始错误**到达调用方手里**时到底是什么形状。
 * 单测层面已经证明解码器认得这些形状，但如果过滤器接线错了一处（比如忘了换掉 catch-all 的
 * `INTERNAL`），只有这条路会红。
 *
 * 触发方式只有两种，都是真造：
 * - **库被另一个进程占死**（`helpers/db-lock-holder.ts`）——真机最常见的 503 现场；
 * - **把表改名**——SCHEMA_MISMATCH 的真实成因（升级包与库版本不匹配、迁移没跑完）。
 * 除这两类之外，从公开端点逼不出「没被业务 catch 的引擎原始抛出」，而这两类恰好就是本次
 * 缺陷的两张脸：以前它们都塌成一句「本地服务内部错误」。
 * 每次只毁一张表、且毁的是本文件用不到的表，所以其余用例互不影响（文件级独占一个临时库）。
 */

interface RpcBody {
  result?: {
    isError?: boolean;
    content?: { type: string; text: string }[];
    structuredContent?: Record<string, unknown>;
    protocolVersion?: string;
  };
}

let t: TestApp;
let ui: Sender;
let http: Sender;
let agent: IssuedAgent;
let rpcSeq = 0;
let negotiated = '';

async function mcpCall(name: string, args: Record<string, unknown> = {}): Promise<Res<RpcBody>> {
  return http.post<RpcBody>(
    '/mcp',
    { jsonrpc: '2.0', id: ++rpcSeq, method: 'tools/call', params: { name, arguments: args } },
    {
      token: agent.token,
      headers: { ...mcpAccept(), ...(negotiated ? { 'mcp-protocol-version': negotiated } : {}) },
      skipEnvelopeCheck: true,
    },
  );
}

beforeAll(async () => {
  t = await createTestApp();
  ui = uiSender(t);
  http = request(t);
  agent = await issueAgent(t, 'qoder-error-refinement');
  const init = await http.post<RpcBody>(
    '/mcp',
    {
      jsonrpc: '2.0',
      id: ++rpcSeq,
      method: 'initialize',
      params: {
        protocolVersion: LATEST_PROTOCOL_VERSION,
        capabilities: {},
        clientInfo: { name: 'atb-error-it', version: '0.0.0' },
      },
    },
    { token: agent.token, headers: mcpAccept(), skipEnvelopeCheck: true },
  );
  negotiated = String(init.body.result?.protocolVersion ?? '');
}, 60_000);

afterAll(async () => {
  await t?.close();
});

describe('数据层异常经真 HTTP 出口后的形状（13 章错误体）', () => {
  it('另一个进程占着库时发写请求 → 503 STORAGE_LOCKED（不再是 500 内部错误）', async () => {
    // 这条就是「同时开了两个本地服务」的现场：以前用户看到「本地服务内部错误」，
    // 现在必须给出「等一会儿 / 只留一个实例」这种做得到的动作。
    const holder = await holdExclusiveLock(t.dir);
    try {
      const res = await ui.post(`${API}/tasks`, { title: '被锁住的那一次创建', type: '需求' });
      expect(res.status, res.text).toBe(503);
      expect(errorCode(res)).toBe('STORAGE_LOCKED');
      expect(errorMessage(res)).toContain('另一个进程');
      expect(errorMessage(res)).not.toContain('内部错误');
    } finally {
      await holder.release();
    }

    // 锁放开后同一条请求就该正常：证明 503 不是我们把成功也吞了。
    const retry = await ui.post(`${API}/tasks`, { title: '锁放开后的重试', type: '需求' });
    expect(retry.status).toBe(201);
  }, 90_000);

  it('缺表 → 500 SCHEMA_MISMATCH，message 说清缺哪张表，原文只进 detail', async () => {
    await t.prisma.$executeRawUnsafe('ALTER TABLE groups RENAME TO groups_broken');

    const res = await ui.get(`${API}/groups`);
    expect(res.status).toBe(500);
    expect(errorCode(res)).toBe('SCHEMA_MISMATCH');
    expect(errorMessage(res)).toContain('缺少表');
    // 13 章错误体：上下文是平铺的 snake_case，不是再套一层。
    const error = (res.body as { error: Record<string, unknown> }).error;
    // detail 是引擎那句原文（模型方法面是 Prisma 自己的措辞，不是 SQLite 的 `no such table`——
    // 两种措辞分别由 P2021 与 P2010+主码 1 两条路进来，都在 error-shape-drift 里钉着）。
    expect(String(error.detail)).toContain('does not exist in the current database');
    expect(String(error.missing)).toBe('groups');
    expect(String(error.message)).not.toMatch(/does not exist/);
    // 旧版这里是一句「服务内部错误」，用户与 Agent 都无从判断该重启还是该反馈。
    expect(error.message).not.toBe('服务内部错误');
  });

  it('同一形状经 MCP 出口给出 isError + 同码同文案（Agent 面不另猜）', async () => {
    await t.prisma.$executeRawUnsafe('ALTER TABLE skills RENAME TO skills_broken');

    const res = await mcpCall('list_skills');
    expect(res.status).toBe(200);
    expect(res.body.result?.isError, res.text).toBe(true);

    const structured = res.body.result?.structuredContent ?? {};
    expect(structured.code).toBe('SCHEMA_MISMATCH');
    expect(String(structured.message)).toContain('缺少表');
    // 两条通道同一份内容：Agent 读 structuredContent 或文本都不会拿到不同结论（12 章）。
    expect(JSON.parse(res.body.result?.content?.[0]?.text ?? '{}')).toMatchObject({
      error: { code: 'SCHEMA_MISMATCH' },
    });
  });

  it('业务自己抛的 ApiException 不被解码器改写：校验与状态机错误仍是原码', async () => {
    const invalid = await ui.post(`${API}/tasks`, { title: '' });
    expect(invalid.status).toBe(422);
    expect(errorCode(invalid)).toBe('VALIDATION_FAILED');

    const missing = await ui.del(`${API}/tasks/T-42424242`);
    expect(missing.status).toBe(404);
    expect(errorCode(missing)).toBe('NOT_FOUND');
  });
});

/**
 * 清单 §14 判据②的出口面（2026-10-09 裁定「Agent 当审核方」整链移除）。
 *
 * `review_mode` 词表由 human/auto/none 收窄为 human/none（迁移 0023 的列级 CHECK 同值），
 * 三个写面都必须：① 拒 `auto`、② 报 `VALIDATION_FAILED` 而不是塌回 `INTERNAL`、
 * ③ 把可接受值念全（13 章细化口径：`details[].message` 里给出 `"human"|"none"`）。
 *
 * MCP 面单独说明：Agent 侧**从来没有** `review_mode` 入参位（0020 草案 Q4「执行者不得自豁免」
 * 的硬不变量），所以「MCP 写 auto」能且只能表现为「未知字段被 `.strict()` 拒」——
 * 这比词表校验更严，本用例把它一并钉住，防止哪天有人为了「兼容」把这个键加回去。
 */
describe('review_mode 词表收窄后的三处写面出口（清单 §14 判据②）', () => {
  const accepted = /"human"\|"none"/;

  it('REST 建单写 auto → 422 VALIDATION_FAILED，details 点名 review_mode 并念全 human/none', async () => {
    const res = await ui.post(`${API}/tasks`, { title: '写 auto 的建单', type: '需求', review_mode: 'auto' });
    expect(res.status, res.text).toBe(422);
    expect(errorCode(res)).toBe('VALIDATION_FAILED');
    expect(errorMessage(res)).not.toContain('内部错误');
    const details = (res.body as { error: { details?: { path: string; message: string }[] } }).error.details ?? [];
    const hit = details.find((item) => item.path === 'review_mode');
    expect(hit, JSON.stringify(details)).toBeDefined();
    expect(hit!.message).toMatch(accepted);
  });

  it('REST 编辑写 auto → 同一形状（PATCH /tasks/:id 与建单共用那份 userTaskPatchSchema）', async () => {
    const created = await ui.post(`${API}/tasks`, { title: '写 auto 的编辑对象', type: '需求' });
    expect(created.status, created.text).toBe(201);
    const id = (created.body as { id: string }).id;

    const res = await ui.patch(`${API}/tasks/${id}`, { review_mode: 'auto' });
    expect(res.status, res.text).toBe(422);
    expect(errorCode(res)).toBe('VALIDATION_FAILED');
    const details = (res.body as { error: { details?: { path: string; message: string }[] } }).error.details ?? [];
    expect(details.find((item) => item.path === 'review_mode')?.message).toMatch(accepted);

    // human / none 两值照常可写：收窄不等于把人审与免审直通一起关掉。
    expect((await ui.patch(`${API}/tasks/${id}`, { review_mode: 'none' })).status).toBe(200);
    expect((await ui.patch(`${API}/tasks/${id}`, { review_mode: 'human' })).status).toBe(200);
  });

  it('设置写 default_review_mode=auto → 422 且 out_of_range 详情念全 human/none', async () => {
    const res = await ui.patch(`${API}/settings`, { default_review_mode: 'auto' });
    expect(res.status, res.text).toBe(422);
    expect(errorCode(res)).toBe('VALIDATION_FAILED');
    const details = (res.body as { error: { details?: { path: string; code: string; message: string }[] } }).error
      .details ?? [];
    expect(details).toHaveLength(1);
    expect(details[0].path).toBe('default_review_mode');
    expect(details[0].code).toBe('out_of_range');
    expect(details[0].message).toMatch(accepted);

    // 存活的两值可写，且写进去就生效（SettingsService「有行用行」）。
    expect((await ui.patch(`${API}/settings`, { default_review_mode: 'none' })).status).toBe(200);
    expect((await ui.patch(`${API}/settings`, { default_review_mode: 'human' })).status).toBe(200);
  });

  it('MCP 面写 review_mode 仍是「不可写键」：auto 与 none 一律按未知字段拒（Q4 不得自豁免）', async () => {
    for (const mode of ['auto', 'none']) {
      const res = await mcpCall('board.create_task', {
        title: `MCP 侧写 review_mode=${mode}`,
        type: '需求',
        session_id: 'conv-14-review-mode',
        agent_name: 'qoder-error-refinement',
        confirmation_mode: 'direct',
        review_mode: mode,
      });
      expect(res.status).toBe(200);
      expect(res.body.result?.isError, res.text).toBe(true);
      expect((res.body.result?.structuredContent ?? {}).code).toBe('VALIDATION_FAILED');
    }
  });
});
