import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestApp, errorCode, request, type Sender, type TestApp } from '../../__tests__/helpers/http-app';
import { API, issueAgent, uiSender } from '../../__tests__/helpers/seed';
import { BreakdownService, type BreakdownDraftInput } from '../breakdown.service';

/**
 * v0.0.4 W7 遗留 b3（§7.4 / 条款 81）：用户侧草案写端点。
 *   POST   /api/v1/breakdown/sessions/{id}/drafts        添加
 *   PATCH  /api/v1/breakdown/sessions/{id}/drafts/{ref}  修改（含歧义/未解析技能重选落定）
 *   DELETE /api/v1/breakdown/sessions/{id}/drafts/{ref}  删除（级联清悬空 depends_on）
 * 守卫：仅 reviewing 可写（§7.7），表外状态 409 BREAKDOWN_BAD_STATE；
 * 依赖兜底：自环/成环 409 DEPENDENCY_CYCLE、未知前置 422（§7.8）。
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
async function reviewingSession(title = `编辑会话 ${Math.random().toString(36).slice(2, 8)}`) {
  const session = await svc.begin({ requirement_text: `${title} 的需求原文`, parent_title: title });
  const drafts: BreakdownDraftInput[] = [
    { ref: 'd1', title: `${title} · 数据模型` },
    { ref: 'd2', title: `${title} · 接口`, depends_on: ['d1'] },
  ];
  for (const draft of drafts) await svc.reportDraft(session.id, draft);
  await svc.finish(session.id);
  return session;
}

async function createSkill(name: string): Promise<string> {
  const res = await ui.post('/api/v1/skills', { name, type: 'workflow' });
  if (res.status !== 201) throw new Error(`建技能失败：${res.status} ${res.text}`);
  return res.body.id as string;
}

describe('POST /breakdown/sessions/{id}/drafts（§7.4 添加任务）', () => {
  it('成功：省略 ref 由服务端取号 t{max+1}，actual_tasks 同步', async () => {
    const session = await reviewingSession();
    const res = await ui.post(`${API}/breakdown/sessions/${session.id}/drafts`, {
      title: '用户补的任务',
      priority: 1,
      depends_on: ['d1'],
    });
    expect(res.status).toBe(201);
    const created = (res.body as { ref: string }[]).find((d) => d.ref === 't3');
    expect(created).toMatchObject({ ref: 't3', title: '用户补的任务', priority: 1, depends_on: ['d1'] });
    const detail = await svc.get(session.id);
    expect(detail.session.actual_tasks).toBe(3);
  });

  it('错误：显式 ref 已被占用回 409 BREAKDOWN_DRAFT_REF_TAKEN', async () => {
    const session = await reviewingSession();
    const res = await ui.post(`${API}/breakdown/sessions/${session.id}/drafts`, { ref: 'd1', title: '撞号' });
    expect(res.status).toBe(409);
    expect(errorCode(res)).toBe('BREAKDOWN_DRAFT_REF_TAKEN');
  });

  it('错误：receiving 会话写入回 409 BREAKDOWN_BAD_STATE（§7.7 仅 reviewing 可编辑）', async () => {
    const receiving = await svc.begin({ requirement_text: '还没拆完', parent_title: '过早编辑' });
    const res = await ui.post(`${API}/breakdown/sessions/${receiving.id}/drafts`, { title: '抢跑' });
    expect(res.status).toBe(409);
    expect(errorCode(res)).toBe('BREAKDOWN_BAD_STATE');
  });

  it('错误：Agent Token 不能调用用户写端点（FORBIDDEN）', async () => {
    const session = await reviewingSession();
    const agent = await issueAgent(t);
    const res = await request(t, agent.token).post(`${API}/breakdown/sessions/${session.id}/drafts`, { title: 'x' });
    expect(res.status).toBe(403);
    expect(errorCode(res)).toBe('FORBIDDEN');
  });
});

describe('PATCH /breakdown/sessions/{id}/drafts/{ref}（§7.4 修改 + 条款 81 可改）', () => {
  it('成功：改标题/描述/优先级，未传字段原样保留', async () => {
    const session = await reviewingSession();
    const res = await ui.patch(`${API}/breakdown/sessions/${session.id}/drafts/d1`, {
      title: '改了标题',
      description: '补了描述',
      priority: 0,
    });
    expect(res.status).toBe(200);
    const d1 = (res.body as { ref: string; depends_on: string[] }[]).find((d) => d.ref === 'd1');
    expect(d1).toMatchObject({ title: '改了标题', description: '补了描述', priority: 0 });
    const detail = await svc.get(session.id);
    expect(detail.drafts.find((d) => d.ref === 'd2')?.depends_on).toEqual(['d1']);
  });

  it('成功：未解析技能重选为真实 id 后落定 resolved（条款 81「可见可改」的写侧闭环）', async () => {
    const skillId = await createSkill(`重选-目标-${Math.random().toString(36).slice(2, 8)}`);
    const missing = `查无此名-${Math.random().toString(36).slice(2, 8)}`;
    const session = await svc.begin({ requirement_text: '重选验证', parent_title: '重选会话' });
    await svc.reportDraft(session.id, { ref: 'd1', title: '坏绑定', skill_ids: [missing] });
    await svc.finish(session.id);
    expect((await svc.get(session.id)).skill_resolution.unresolved).toEqual([{ ref: 'd1', name: missing }]);

    const res = await ui.patch(`${API}/breakdown/sessions/${session.id}/drafts/d1`, { skill_ids: [skillId] });
    expect(res.status).toBe(200);
    const after = await svc.get(session.id);
    expect(after.drafts.find((d) => d.ref === 'd1')?.skill_ids).toEqual([skillId]);
    expect(after.drafts.find((d) => d.ref === 'd1')?.skills_status).toEqual([
      { value: skillId, state: 'resolved', skill_id: skillId, name: expect.any(String), candidates: [skillId] },
    ]);
    expect(after.skill_resolution).toEqual({ ambiguous: [], unresolved: [] });
  });

  it('错误：成环/自引用/未知前置/非法 priority 全部拒绝（§7.8 服务端兜底）', async () => {
    const session = await reviewingSession();
    const cycle = await ui.patch(`${API}/breakdown/sessions/${session.id}/drafts/d1`, { depends_on: ['d2'] });
    expect(cycle.status).toBe(409);
    expect(errorCode(cycle)).toBe('DEPENDENCY_CYCLE');

    const self = await ui.patch(`${API}/breakdown/sessions/${session.id}/drafts/d1`, { depends_on: ['d1'] });
    expect(self.status).toBe(409);
    expect(errorCode(self)).toBe('DEPENDENCY_CYCLE');

    const unknown = await ui.patch(`${API}/breakdown/sessions/${session.id}/drafts/d1`, { depends_on: ['nobody'] });
    expect(unknown.status).toBe(422);
    expect(errorCode(unknown)).toBe('VALIDATION_FAILED');

    const badPriority = await ui.patch(`${API}/breakdown/sessions/${session.id}/drafts/d1`, { priority: 9 });
    expect(badPriority.status).toBe(422);
    expect(errorCode(badPriority)).toBe('VALIDATION_FAILED');

    const emptyTitle = await ui.patch(`${API}/breakdown/sessions/${session.id}/drafts/d1`, { title: '   ' });
    expect(emptyTitle.status).toBe(422);
    expect(errorCode(emptyTitle)).toBe('VALIDATION_FAILED');
  });

  it('错误：未知会话 404、未知草案 404、confirm 后（completed）409', async () => {
    const gone = await ui.patch(`${API}/breakdown/sessions/01947c3e-6f2a-7a11-9c31-8d5f2e1b7c99/drafts/d1`, { title: 'x' });
    expect(gone.status).toBe(404);
    expect(errorCode(gone)).toBe('NOT_FOUND');

    const session = await reviewingSession();
    const missingRef = await ui.patch(`${API}/breakdown/sessions/${session.id}/drafts/n9`, { title: 'x' });
    expect(missingRef.status).toBe(404);
    expect(errorCode(missingRef)).toBe('NOT_FOUND');

    await ui.post(`${API}/breakdown/sessions/${session.id}/confirm`);
    const late = await ui.patch(`${API}/breakdown/sessions/${session.id}/drafts/d1`, { title: '晚了' });
    expect(late.status).toBe(409);
    expect(errorCode(late)).toBe('BREAKDOWN_BAD_STATE');
  });
});

describe('DELETE /breakdown/sessions/{id}/drafts/{ref}（§7.4 删除 + 级联）', () => {
  it('成功：删 d1 后 d2 的悬空依赖被清掉，actual_tasks 同步', async () => {
    const session = await reviewingSession();
    const res = await ui.del(`${API}/breakdown/sessions/${session.id}/drafts/d1`);
    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(1);
    expect(res.body[0]).toMatchObject({ ref: 'd2', depends_on: [] });
    const detail = await svc.get(session.id);
    expect(detail.session.actual_tasks).toBe(1);
  });

  it('错误：未知草案 404；cancelled 会话 409（越态守卫）', async () => {
    const session = await reviewingSession();
    const missing = await ui.del(`${API}/breakdown/sessions/${session.id}/drafts/n9`);
    expect(missing.status).toBe(404);
    expect(errorCode(missing)).toBe('NOT_FOUND');

    await svc.cancel(session.id);
    const late = await ui.del(`${API}/breakdown/sessions/${session.id}/drafts/d1`);
    expect(late.status).toBe(409);
    expect(errorCode(late)).toBe('BREAKDOWN_BAD_STATE');
  });
});
