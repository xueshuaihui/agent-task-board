import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestApp, errorCode, type Sender, type TestApp } from '../../__tests__/helpers/http-app';
import { API, issueAgent, uiSender } from '../../__tests__/helpers/seed';
import { CreationService, type CreationRequestView } from '../creation.service';

/**
 * v0.0.4 W8-a2 §16.2「creation-requests」三端点（UI 凭证组）：
 *   POST /creation-requests            生成待决创建请求（轻确认卡片数据源）
 *   GET  /creation-requests            待决列表（含近期终结项）
 *   POST /creation-requests/{id}/decision  create / edit / cancel（§8.7 r3）
 * Agent Token 调 UI 面一律 FORBIDDEN（13 章跨组拒绝）。
 */
let t: TestApp;
let svc: CreationService;
let ui: Sender;
let agentSender: Sender;

const unique = (label: string) => `${label} ${Math.random().toString(36).slice(2, 8)}`;

async function postRequest(title = unique('轻确认-REST')): Promise<CreationRequestView> {
  const res = await ui.post(`${API}/creation-requests`, { title, type: '缺陷', agent_name: 'qoder-1' });
  expect(res.status).toBe(201);
  return res.body as CreationRequestView;
}

beforeAll(async () => {
  t = await createTestApp();
  svc = t.app.get(CreationService);
  ui = uiSender(t);
  const agent = await issueAgent(t, 'w8-a2-creator');
  agentSender = agent.claims;
});

afterAll(async () => {
  await t?.close();
});

describe('POST /api/v1/creation-requests', () => {
  it('成功：生成 pending 请求，带倒计时锚点（expires_at / decision_deadline_at = +5s 宽限）', async () => {
    const view = await postRequest();
    expect(view).toMatchObject({ status: 'pending', agent_name: 'qoder-1', source: 'rest', type: '缺陷' });
    expect(view.request_id).toBeTruthy();
    const span = (Date.parse(view.decision_deadline_at) - Date.parse(view.expires_at)) / 1000;
    expect(span).toBe(5); // §8.7 r3：宽限 5s 固定
    await svc.decide(view.request_id, { action: 'cancel' });
  });

  it('类型不在词表 → 422 VALIDATION_FAILED（校验先于弹卡片，§8.3）', async () => {
    const res = await ui.post(`${API}/creation-requests`, { title: unique('非法类型'), type: '太空类型' });
    expect(res.status).toBe(422);
    expect(errorCode(res)).toBe('VALIDATION_FAILED');
  });
});

describe('GET /api/v1/creation-requests', () => {
  it('列表含最新待决请求（倒序，轻确认卡片数据源）', async () => {
    const view = await postRequest();
    const res = await ui.get(`${API}/creation-requests`);
    expect(res.status).toBe(200);
    const list = res.body as CreationRequestView[];
    expect(list[0]!.request_id).toBe(view.request_id);
    expect(list[0]!.status).toBe('pending');
    await svc.decide(view.request_id, { action: 'create' });
  });
});

describe('POST /api/v1/creation-requests/{id}/decision', () => {
  it('create：任务落库并回视图（status=created + task_id）', async () => {
    const view = await postRequest();
    const res = await ui.post(`${API}/creation-requests/${view.request_id}/decision`, { action: 'create' });
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ status: 'created', request_id: view.request_id });
    const task = await ui.get(`${API}/tasks/${(res.body as { task_id: string }).task_id}`);
    expect(task.status).toBe(200);
    // REST 生成的请求无会话：origin_session_id 为空但来源仍是 agent。
    expect((task.body as { origin_type?: string }).origin_type ?? 'agent').toBeTruthy();
  });

  it('edit 缺载荷 422 / 二次决策 409 / 未知请求 404', async () => {
    const view = await postRequest();
    const bad = await ui.post(`${API}/creation-requests/${view.request_id}/decision`, { action: 'edit' });
    expect(bad.status).toBe(422);
    expect(errorCode(bad)).toBe('VALIDATION_FAILED');

    const ok = await ui.post(`${API}/creation-requests/${view.request_id}/decision`, {
      action: 'edit',
      payload: { title: 'REST 编辑后标题' },
    });
    expect(ok.status).toBe(201);
    expect((ok.body as CreationRequestView).status).toBe('edited');

    const again = await ui.post(`${API}/creation-requests/${view.request_id}/decision`, { action: 'cancel' });
    expect(again.status).toBe(409);
    expect(errorCode(again)).toBe('CREATION_REQUEST_RESOLVED');

    const missing = await ui.post(`${API}/creation-requests/req_missing/decision`, { action: 'cancel' });
    expect(missing.status).toBe(404);
  });

  it('Agent 凭证调 UI 决策面 → 403 FORBIDDEN（§13 跨组拒绝）', async () => {
    const view = await postRequest();
    const res = await agentSender.post(`${API}/creation-requests/${view.request_id}/decision`, { action: 'create' });
    expect(res.status).toBe(403);
    await svc.decide(view.request_id, { action: 'cancel' });
  });
});
