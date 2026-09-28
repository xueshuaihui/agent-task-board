import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestApp, errorCode, type TestApp } from './helpers/http-app';
import { API, issueAgent, newTask, toReview, uiSender } from './helpers/seed';
import type { Sender } from './helpers/http-app';

/**
 * 0020 草案 §3.4（A2）的人侧换轨出口：`POST /api/v1/tasks/:id/review/escalate`。
 *
 * 只测 HTTP 面该管的事：鉴权组别（与 review 同 scope）、两条前置拒绝分支
 * （非 REVIEW / 已在人工轨 → 409，错误码沿用既有的 ILLEGAL_TRANSITION，不加新码）、
 * 换轨成功的落库形状（track=human + review_pending + 升级评论，任务留在 REVIEW 列）。
 * 结论流转本身（APPROVE/REJECT/ESCALATE 三路）在 review-queue.test.ts 钉死，这里不重复。
 */
let t: TestApp;
let ui: Sender;

beforeAll(async () => {
  t = await createTestApp();
  ui = uiSender(t);
}, 60_000);

afterAll(async () => {
  await t?.close();
});

/** 建一支 auto 任务并走完整链路推到 REVIEW/track=auto（PATCH 在 BACKLOG 期完成，A1 口径）。 */
async function toAutoReview(title: string): Promise<string> {
  const id = await newTask(t, { title });
  const patched = await ui.patch(`${API}/tasks/${id}`, { review_mode: 'auto' });
  if (patched.status !== 200) throw new Error(`设置 auto 审核失败：${patched.status} ${patched.text}`);
  await toReview(t, id);
  return id;
}

async function notificationsOf(id: string, kind: string): Promise<number> {
  return t.prisma.notification.count({ where: { kind, taskId: id } });
}

describe('POST /tasks/:id/review/escalate（人侧换轨）', () => {
  it('REVIEW/track=auto → 201，任务留在 REVIEW 换轨 human，推 review_pending 与升级评论', async () => {
    const id = await toAutoReview('换轨出口-正常');

    const res = await ui.post(`${API}/tasks/${id}/review/escalate`, { reason: '产物口径存疑' });

    expect(res.status).toBe(201);
    expect(res.body.status).toBe('REVIEW');
    expect(res.body.review_track).toBe('human');
    expect(await notificationsOf(id, 'review_pending')).toBe(1);
    // 人侧入口不带「自动审核升级人工（原因…）」的机器署名口径也合法——reason 有值就进评论。
    const comment = await t.prisma.comment.findFirst({
      where: { taskId: id, type: 'status_change', content: { contains: '自动审核升级人工' } },
    });
    expect(comment?.authorType).toBe('system');
    expect(comment?.content).toContain('产物口径存疑');
  });

  it('再点一次换轨 → 409：条件更新闸挡住重复评论/审计/通知', async () => {
    const id = await toAutoReview('换轨出口-重复');
    expect((await ui.post(`${API}/tasks/${id}/review/escalate`, {})).status).toBe(201);
    await t.prisma.notification.deleteMany();

    const again = await ui.post(`${API}/tasks/${id}/review/escalate`, {});
    expect(again.status).toBe(409);
    expect(errorCode(again)).toBe('ILLEGAL_TRANSITION');
    expect(await notificationsOf(id, 'review_pending')).toBe(0);
  });

  it('非 REVIEW 任务 → 409（前置守卫，与看板状态闸同口径）', async () => {
    const id = await newTask(t, { title: '换轨出口-不在审核列' });

    const res = await ui.post(`${API}/tasks/${id}/review/escalate`, {});
    expect(res.status).toBe(409);
    expect(errorCode(res)).toBe('ILLEGAL_TRANSITION');
  });

  it('human 模式的任务（track 本来就是 human）→ 409：无需换轨', async () => {
    const id = await newTask(t, { title: '换轨出口-人审任务' });
    await toReview(t, id);

    const res = await ui.post(`${API}/tasks/${id}/review/escalate`, {});
    expect(res.status).toBe(409);
    expect(errorCode(res)).toBe('ILLEGAL_TRANSITION');
    expect(res.body.error.message).toContain('已在人工审核队列');
  });

  it('端点属 UI scope：Agent Token 打过来 403（13 章跨组拒绝）', async () => {
    const id = await toAutoReview('换轨出口-越权');
    const agent = await issueAgent(t, 'escalate-peeker');

    const res = await agent.claims.post(`${API}/tasks/${id}/review/escalate`, {});
    expect(res.status).toBe(403);
    expect(errorCode(res)).toBe('FORBIDDEN');
    expect(await t.prisma.task.findUniqueOrThrow({ where: { id } })).toMatchObject({
      reviewTrack: 'auto',
    });
  });
});
