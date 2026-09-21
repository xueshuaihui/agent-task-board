import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestApp, errorCode, request, type Sender, type TestApp } from '../../__tests__/helpers/http-app';
import { API, issueAgent, uiSender } from '../../__tests__/helpers/seed';
import { BreakdownService, type BreakdownDraftInput } from '../breakdown.service';

/**
 * v0.0.4 W7 §16.2「拆解」四端点：
 *   GET  /api/v1/breakdown/sessions · GET /sessions/{id} ·
 *   POST /sessions/{id}/confirm · POST /sessions/{id}/cancel
 * 会话由 Agent 面（MCP board.* 或直接服务层）造出，这里只测 UI 面的读与决策。
 */
let t: TestApp;
let svc: BreakdownService;
let ui: Sender;

beforeAll(async () => {
  t = await createTestApp();
  svc = t.app.get(BreakdownService);
  ui = uiSender(t);
});

afterAll(async () => {
  await t?.close();
});

/** 造一个 reviewing 会话：begin → 两条草案（d2 依赖 d1）→ finish。 */
async function reviewingSession(title = `拆解会话 ${Math.random().toString(36).slice(2, 8)}`) {
  const session = await svc.begin({ requirement_text: `${title} 的需求原文`, parent_title: title });
  const drafts: BreakdownDraftInput[] = [
    { ref: 'd1', title: `${title} · 数据模型` },
    { ref: 'd2', title: `${title} · 接口`, depends_on: ['d1'] },
  ];
  for (const draft of drafts) await svc.reportDraft(session.id, draft);
  await svc.reportProgress(session.id, { step: 1, total: 2 });
  const finished = await svc.finish(session.id);
  return { session, drafts, finished };
}

describe('GET /api/v1/breakdown/sessions', () => {
  it('成功：返回会话列表（含最新会话，倒序）', async () => {
    const created = await svc.begin({ requirement_text: '列表可见性', parent_title: '列表需求' });
    const res = await ui.get(`${API}/breakdown/sessions`);
    expect(res.status).toBe(200);
    const ids = (res.body as { id: string }[]).map((row) => row.id);
    expect(ids[0]).toBe(created.id); // created_at DESC：最新到达的会话在首位
  });

  it('错误：Agent Token 不能调用用户接口（FORBIDDEN，跨组拒绝 §13）', async () => {
    const agent = await issueAgent(t);
    const res = await request(t, agent.token).get(`${API}/breakdown/sessions`);
    expect(res.status).toBe(403);
    expect(errorCode(res)).toBe('FORBIDDEN');
  });
});

describe('GET /api/v1/breakdown/sessions/{id}', () => {
  it('成功：session + drafts + progress 三段齐全（确认页数据源 §7.3）', async () => {
    const { session, drafts } = await reviewingSession();
    const res = await ui.get(`${API}/breakdown/sessions/${session.id}`);
    expect(res.status).toBe(200);
    expect(res.body.session).toMatchObject({ id: session.id, status: 'reviewing', actual_tasks: 2 });
    expect(res.body.drafts.map((d: { ref: string }) => d.ref)).toEqual(drafts.map((d) => d.ref));
    expect(res.body.progress).toHaveLength(1);
  });

  it('错误：未知会话 404 NOT_FOUND，且是 13 章错误体', async () => {
    const res = await ui.get(`${API}/breakdown/sessions/01947c3e-6f2a-7a11-9c31-8d5f2e1b7c99`);
    expect(res.status).toBe(404);
    expect(errorCode(res)).toBe('NOT_FOUND');
  });
});

describe('POST /api/v1/breakdown/sessions/{id}/confirm', () => {
  it('成功：批量建父任务 + 子任务并落依赖边（§7.8 全成才提交）', async () => {
    const { session } = await reviewingSession();
    const res = await ui.post(`${API}/breakdown/sessions/${session.id}/confirm`);
    expect(res.status).toBe(201);
    expect(res.body.session.status).toBe('completed');
    const parent = await t.prisma.task.findUniqueOrThrow({ where: { id: res.body.parent_task_id } });
    expect(parent).toMatchObject({ type: '需求', title: session.parent_title, breakdownSessionId: session.id });
    expect(res.body.task_ids).toHaveLength(2);
    const edges = await t.prisma.taskDependency.findMany({ where: { taskId: { in: res.body.task_ids } } });
    expect(edges).toHaveLength(1);
  });

  it('错误：receiving 中确认回 409 BREAKDOWN_BAD_STATE；未知会话 404', async () => {
    const receiving = await svc.begin({ requirement_text: '还没拆完', parent_title: '过早确认' });
    const bad = await ui.post(`${API}/breakdown/sessions/${receiving.id}/confirm`);
    expect(bad.status).toBe(409);
    expect(errorCode(bad)).toBe('BREAKDOWN_BAD_STATE');

    const gone = await ui.post(`${API}/breakdown/sessions/01947c3e-6f2a-7a11-9c31-8d5f2e1b7c98/confirm`);
    expect(gone.status).toBe(404);
    expect(errorCode(gone)).toBe('NOT_FOUND');
  });
});

describe('POST /api/v1/breakdown/sessions/{id}/cancel', () => {
  it('成功：receiving 会话取消，转 cancelled（§7.7）', async () => {
    const session = await svc.begin({ requirement_text: '半途而废', parent_title: '取消测试' });
    const res = await ui.post(`${API}/breakdown/sessions/${session.id}/cancel`);
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ id: session.id, status: 'cancelled' });
    expect(res.body.cancelled_at).not.toBeNull();
  });

  it('错误：已取消再取消回 409；completed 也回 409（终态不可动）', async () => {
    const session = await svc.begin({ requirement_text: '取消两次', parent_title: '重复取消' });
    await svc.cancel(session.id);
    const again = await ui.post(`${API}/breakdown/sessions/${session.id}/cancel`);
    expect(again.status).toBe(409);
    expect(errorCode(again)).toBe('BREAKDOWN_BAD_STATE');

    const { session: done } = await reviewingSession();
    await ui.post(`${API}/breakdown/sessions/${done.id}/confirm`);
    const afterCompleted = await ui.post(`${API}/breakdown/sessions/${done.id}/cancel`);
    expect(afterCompleted.status).toBe(409);
    expect(errorCode(afterCompleted)).toBe('BREAKDOWN_BAD_STATE');
  });
});
