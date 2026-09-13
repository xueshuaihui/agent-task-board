import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  createTestApp,
  errorCode,
  errorMessage,
  request,
  type TestApp,
} from './helpers/http-app';
import { API, anonSender, issueAgent, newTask, toReady, uiSender } from './helpers/seed';

/**
 * 13 章「认证」表 + 跨组拒绝 + 验收 2/32。
 *
 * 两类凭证的隔离是 15 章权限矩阵唯一的落地位置，所以这里逐条钉：
 * UI 会话 Token 打 Agent 组 → 403（有身份、组不对）；不带凭证 → 401；
 * Agent Token 打用户组 → 403；`GET /api/v1/tasks/{id}` 是唯一「任一凭证均可」的只读端点；
 * 根路径不提供静态页（验收 2）。
 */
let t: TestApp;
let ui: ReturnType<typeof uiSender>;
let anon: ReturnType<typeof anonSender>;
let agent: Awaited<ReturnType<typeof issueAgent>>;
let readyTaskId: string;

beforeAll(async () => {
  t = await createTestApp();
  ui = uiSender(t);
  anon = anonSender(t);
  agent = await issueAgent(t, 'go-worker', ['language:go']);
  readyTaskId = await newTask(t, { title: '支付回调修复' });
  await toReady(t, readyTaskId);
}, 60_000);

afterAll(async () => {
  await t?.close();
});

describe('UI 会话 Token 不能调用 Agent 写回组', () => {
  it('claim / heartbeat / complete / progress / logs / ready / review-feedback 一律 403', async () => {
    const calls = [
      ui.post(`${API}/tasks/claim`, {}),
      ui.get(`${API}/tasks/ready`),
      ui.post(`${API}/tasks/${readyTaskId}/heartbeat`, {
        task_id: readyTaskId,
        run_id: 'R-2001',
        lease_id: '00000000-0000-0000-0000-000000000000',
      }),
      ui.post(`${API}/tasks/${readyTaskId}/progress`, {
        task_id: readyTaskId,
        run_id: 'R-2001',
        lease_id: '00000000-0000-0000-0000-000000000000',
        progress: 10,
      }),
      ui.post(`${API}/tasks/${readyTaskId}/logs`, {
        task_id: readyTaskId,
        run_id: 'R-2001',
        lease_id: '00000000-0000-0000-0000-000000000000',
        lines: ['hi'],
      }),
      ui.post(`${API}/tasks/${readyTaskId}/complete`, {
        task_id: readyTaskId,
        run_id: 'R-2001',
        lease_id: '00000000-0000-0000-0000-000000000000',
      }),
      ui.post(`${API}/tasks/${readyTaskId}/fail`, {
        task_id: readyTaskId,
        run_id: 'R-2001',
        lease_id: '00000000-0000-0000-0000-000000000000',
        error: 'boom',
      }),
      ui.get(`${API}/tasks/${readyTaskId}/review-feedback`),
    ];
    const results = await Promise.all(calls);
    expect(results.map((res) => res.status)).toEqual(results.map(() => 403));
    expect(results.map((res) => errorCode(res))).toEqual(results.map(() => 'FORBIDDEN'));
  });

  it('MCP 端点同样属于 Agent 组，UI 会话 Token 打过来是 403 而不是 200', async () => {
    const res = await ui.post(
      '/mcp',
      { jsonrpc: '2.0', id: 1, method: 'tools/list' },
      { headers: { accept: 'application/json, text/event-stream' } },
    );
    expect(res.status).toBe(403);
    expect(errorCode(res)).toBe('FORBIDDEN');
  });
});

describe('Agent Token 不能调用任何用户接口', () => {
  it('看板、任务写、审核、设置、Token、备份、字段定义、数据导出全部 403', async () => {
    const calls = [
      agent.claims.get(`${API}/board`),
      agent.claims.post(`${API}/tasks`, { title: '越权建任务', type: '需求' }),
      agent.claims.post(`${API}/tasks/${readyTaskId}/transition`, { to: 'DONE' }),
      agent.claims.post(`${API}/tasks/${readyTaskId}/stop`, {}),
      agent.claims.post(`${API}/tasks/${readyTaskId}/review`, {
        conclusion: 'APPROVE',
        suggestion: 's',
        reason: 'r',
        detail: 'd',
      }),
      agent.claims.get(`${API}/settings`),
      agent.claims.get(`${API}/tokens`),
      agent.claims.get(`${API}/field-defs`),
      agent.claims.get(`${API}/templates`),
      agent.claims.get(`${API}/notifications`),
      agent.claims.get(`${API}/audit`),
      agent.claims.post(`${API}/data/export`, { scope: 'all', include_archived: false }),
      agent.claims.post(`${API}/settings/backup`, {}),
    ];
    const results = await Promise.all(calls);
    expect(results.map((res) => res.status)).toEqual(results.map(() => 403));
    expect(results.map((res) => errorCode(res))).toEqual(results.map(() => 'FORBIDDEN'));
  });
});

describe('无凭证与凭证本身的有效性', () => {
  it('不带 Authorization 的用户接口是 401，不是 403', async () => {
    const res = await anon.get(`${API}/board`);
    expect(res.status).toBe(401);
    expect(errorCode(res)).toBe('UNAUTHORIZED');
    expect(errorMessage(res)).toBe('缺少凭证');
  });

  it('不带 Authorization 的 claim 是 401；不带 Authorization 的 /mcp 也是 401', async () => {
    expect((await anon.post(`${API}/tasks/claim`, {})).status).toBe(401);
    const mcp = await anon.post(
      '/mcp',
      { jsonrpc: '2.0', id: 1, method: 'tools/list' },
      { headers: { accept: 'application/json, text/event-stream' } },
    );
    expect(mcp.status).toBe(401);
    expect(errorCode(mcp)).toBe('UNAUTHORIZED');
  });

  it('随机 Bearer 与空 Bearer 都是 401 凭证无效', async () => {
    const random = request(t, 'atb_not_a_real_token_value_at_all');
    const empty = request(t, '   ');
    expect((await random.get(`${API}/board`)).status).toBe(401);
    expect((await empty.get(`${API}/board`)).status).toBe(401);
  });

  it('吊销后的 Agent Token 一律 401（13 章：Token 已吊销）', async () => {
    const temp = await issueAgent(t, 'temp-worker');
    expect((await temp.claims.get(`${API}/tasks/ready`)).status).toBe(200);
    await temp.ui.del(`${API}/tokens/${temp.id}`);
    const after = await temp.claims.get(`${API}/tasks/ready`);
    expect(after.status).toBe(401);
    expect(errorCode(after)).toBe('UNAUTHORIZED');
    expect(errorMessage(after)).toBe('Token 已吊销');
  });
});

describe('GET /api/v1/tasks/{id} 是唯一「任一凭证均可」的只读端点', () => {
  it('UI 会话 Token 读得到', async () => {
    const res = await ui.get(`${API}/tasks/${readyTaskId}`);
    expect(res.status).toBe(200);
    expect(res.body.id).toBe(readyTaskId);
    expect(res.body.status).toBe('READY');
  });

  it('Agent Token 也读得到，且载荷与 UI 侧同源', async () => {
    const viaAgent = await agent.claims.get(`${API}/tasks/${readyTaskId}`);
    const viaUi = await ui.get(`${API}/tasks/${readyTaskId}`);
    expect(viaAgent.status).toBe(200);
    expect(viaAgent.body).toEqual(viaUi.body);
  });

  it('同一路径前缀下的写端点仍然只对 UI 开放', async () => {
    expect((await agent.claims.patch(`${API}/tasks/${readyTaskId}`, { priority: 1 })).status).toBe(403);
    expect((await agent.claims.del(`${API}/tasks/${readyTaskId}`)).status).toBe(403);
    expect((await agent.claims.get(`${API}/tasks/${readyTaskId}/runs`)).status).toBe(403);
    expect((await agent.claims.post(`${API}/tasks/${readyTaskId}/comments`, { content: 'x' })).status).toBe(403);
  });

  it('`GET /tasks/ready` 不被 `tasks/:id` 抢走：Agent 组可读、UI 组 403', async () => {
    const byAgent = await agent.claims.get(`${API}/tasks/ready`);
    expect(byAgent.status).toBe(200);
    expect(byAgent.body.items.map((item: { id: string }) => item.id)).toContain(readyTaskId);
    expect((await ui.get(`${API}/tasks/ready`)).status).toBe(403);
    // 守卫先看「有没有 Bearer」再看组别：无凭证打 Agent 组是 401，带 UI 会话 Token 才是 403。
    expect((await anon.get(`${API}/tasks/ready`)).status).toBe(401);
  });
});

describe('根路径不提供界面（验收 2）', () => {
  it('GET / → 404，且响应体不是 HTML', async () => {
    const res = await request(t).get('/');
    expect(res.status).toBe(404);
    expect(res.headers.get('content-type') ?? '').not.toMatch(/text\/html/i);
    expect(res.text).not.toMatch(/<html|<!DOCTYPE/i);
    expect(errorCode(res)).toBe('NOT_FOUND');
  });

  it('任意未注册前缀都是 404 NOT_FOUND，不回落静态页', async () => {
    for (const url of ['/index.html', '/assets/app.js', '/api/v2/board', '/api/v1/nope']) {
      const res = await request(t).get(url);
      expect(res.status, url).toBe(404);
      expect(errorCode(res), url).toBe('NOT_FOUND');
    }
  });
});
