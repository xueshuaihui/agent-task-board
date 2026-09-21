import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ApiException } from '../../contract/errors';
import { BreakdownService, type BreakdownDraftInput } from '../breakdown.service';
import type { Task } from '@prisma/client';
import { createTestApp, type TestApp } from '../../__tests__/helpers/http-app';
import { uiSender } from '../../__tests__/helpers/seed';

/**
 * v0.0.4 W7 拆解服务层单测（§7.2 全生命周期 + §7.5 技能解析 + §7.8 边界）。
 * controller 端点属下一切片，这里直接取容器里的 BreakdownService 调用。
 */

let t: TestApp;
let svc: BreakdownService;

beforeAll(async () => {
  t = await createTestApp();
  svc = t.app.get(BreakdownService);
});

afterAll(async () => {
  await t?.close();
});

async function createSkill(name: string): Promise<string> {
  const res = await uiSender(t).post('/api/v1/skills', { name, type: 'workflow' });
  if (res.status !== 201) throw new Error(`建技能失败：${res.status} ${res.text}`);
  return res.body.id as string;
}

async function taskRow(id: string): Promise<Task | null> {
  return t.prisma.task.findUnique({ where: { id } });
}

function expectError(call: () => Promise<unknown>, code: string, status: number): Promise<ApiException> {
  return call().then(
    () => {
      throw new Error(`期望抛 ${code}，实际成功`);
    },
    (err: unknown) => {
      expect(err).toBeInstanceOf(ApiException);
      const api = err as ApiException;
      expect(api.code).toBe(code);
      expect(api.status).toBe(status);
      return api;
    },
  );
}

describe('拆解链路主路径：begin → progress → drafts → finish（技能解析）→ confirm（建任务）', () => {
  it('走完全程：父任务+子任务落库、依赖边建立、技能一律存 id、来源记录在 breakdown_session_id', async () => {
    const solo = await createSkill(`拆解专用技能-${Math.random().toString(36).slice(2, 8)}`);
    const twinName = `同名 twin-${Math.random().toString(36).slice(2, 8)}`;
    const twinOld = await createSkill(twinName);
    const twinNew = await createSkill(twinName); // 后创建者 updatedAt 更新，应被选中
    const missing = `不存在技能-${Math.random().toString(36).slice(2, 8)}`;

    const session = await svc.begin({
      requirement_text: '实现优惠券功能',
      parent_title: '优惠券功能',
      parent_description: '需求：优惠券全链路',
      estimated_tasks: 3,
      agent_name: 'qoder',
    });
    expect(session.status).toBe('receiving');

    await svc.reportProgress(session.id, { step: 1, total: 3, message: '识别工作单元' });
    const drafts: BreakdownDraftInput[] = [
      { ref: 'd1', title: '设计数据模型', skill_ids: [solo, twinName] },
      { ref: 'd2', title: '创建接口', depends_on: ['d1'], skill_ids: [missing], priority: 1 },
      { ref: 'd3', title: '前端联调', depends_on: ['d2'], sort_order: 2 },
    ];
    for (const draft of drafts) await svc.reportDraft(session.id, draft);
    // 同 ref 重报即覆盖（§7.6 UNIQUE (session_id, ref)）。
    await svc.reportDraft(session.id, { ...drafts[2]!, title: '前端联调（修订）' });

    const finished = await svc.finish(session.id);
    expect(finished.session.status).toBe('reviewing');
    expect(finished.session.actual_tasks).toBe(3);
    expect(finished.session.finished_at).not.toBeNull();
    // §7.5：精确名唯一命中→id；同名多技能→最近更新者+歧义标注；无法解析→告警不阻断。
    expect(finished.skill_resolution.ambiguous).toHaveLength(1);
    expect(finished.skill_resolution.ambiguous[0]).toMatchObject({ ref: 'd1', name: twinName });
    expect(finished.skill_resolution.ambiguous[0]!.skill_id).toBe(twinNew);
    expect(finished.skill_resolution.ambiguous[0]!.candidates.sort()).toEqual([twinNew, twinOld].sort());
    expect(finished.skill_resolution.unresolved).toEqual([{ ref: 'd2', name: missing }]);

    const detail = await svc.get(session.id);
    expect(detail.progress).toHaveLength(1);
    expect(detail.drafts.find((d) => d.ref === 'd1')!.skill_ids).toEqual([solo, twinNew]);
    expect(detail.drafts.find((d) => d.ref === 'd3')!.title).toBe('前端联调（修订）');

    const confirmed = await svc.confirm(session.id);
    expect(confirmed.session.status).toBe('completed');
    expect(confirmed.session.parent_task_id).toBe(confirmed.parent_task_id);
    expect(confirmed.session.confirmed_at).not.toBeNull();
    expect(confirmed.task_ids).toHaveLength(3);

    const parent = await taskRow(confirmed.parent_task_id);
    expect(parent).toMatchObject({ type: '需求', title: '优惠券功能', parentTaskId: null, breakdownSessionId: session.id });
    const children = await t.prisma.task.findMany({ where: { id: { in: confirmed.task_ids } } });
    expect(children).toHaveLength(3);
    for (const child of children) {
      expect(child).toMatchObject({ type: '子任务', parentTaskId: confirmed.parent_task_id, groupId: parent!.groupId, status: 'BACKLOG' });
      expect(child.breakdownSessionId).toBe(session.id);
    }
    const byRef = new Map(detail.drafts.map((d, i) => [d.ref, confirmed.task_ids[i]]));
    expect(JSON.parse(children.find((c) => c.id === byRef.get('d1'))!.skills)).toEqual([solo, twinNew]);
    // §7.4 未解析技能确认页删除后落库不含表外值：未解析名字不写进 tasks.skills。
    expect(JSON.parse(children.find((c) => c.id === byRef.get('d2'))!.skills)).toEqual([]);

    const edges = await t.prisma.taskDependency.findMany({ where: { taskId: { in: confirmed.task_ids } } });
    expect(edges).toHaveLength(2);
    expect(edges.map((e) => [e.taskId, e.dependsOn, e.type])).toEqual(
      expect.arrayContaining([
        [byRef.get('d2'), byRef.get('d1'), 'blocks'],
        [byRef.get('d3'), byRef.get('d2'), 'blocks'],
      ]),
    );

    const audit = await t.prisma.auditLog.findMany({ where: { action: 'breakdown_confirm', targetId: session.id } });
    expect(audit).toHaveLength(1);
  });
});

describe('错误路径一：会话不存在 → NOT_FOUND(404)', () => {
  it('get/finish/confirm/cancel 对未知会话 id 统一 404', async () => {
    for (const call of [
      () => svc.get('nope'),
      () => svc.finish('nope'),
      () => svc.confirm('nope'),
      () => svc.cancel('nope'),
    ]) {
      const err = await expectError(call, 'NOT_FOUND', 404);
      expect(err.message).toContain('拆解会话不存在');
    }
  });
});

describe('错误路径二：状态机守卫 → BREAKDOWN_BAD_STATE(409) / 成环 → DEPENDENCY_CYCLE(409)', () => {
  it('receiving 期直接 confirm、reviewing 后再 finish、终态后再 cancel 都被 409 拒绝', async () => {
    const early = await svc.begin({ requirement_text: 'r', parent_title: 'p' });
    await expectError(() => svc.confirm(early.id), 'BREAKDOWN_BAD_STATE', 409);

    const done = await svc.begin({ requirement_text: 'r', parent_title: 'p' });
    await svc.reportDraft(done.id, { ref: 'a', title: '甲' });
    await svc.finish(done.id);
    await expectError(() => svc.finish(done.id), 'BREAKDOWN_BAD_STATE', 409);
    const confirmed = await svc.confirm(done.id);
    await expectError(() => svc.cancel(done.id), 'BREAKDOWN_BAD_STATE', 409);
    expect(confirmed.task_ids).toHaveLength(1);

    // §7.8 依赖成环：finish 即拒绝，会话留在 receiving 可修复重报。
    const cyclic = await svc.begin({ requirement_text: 'r', parent_title: 'p' });
    await svc.reportDraft(cyclic.id, { ref: 'x', title: 'x', depends_on: ['y'] });
    await svc.reportDraft(cyclic.id, { ref: 'y', title: 'y', depends_on: ['x'] });
    const err = await expectError(() => svc.finish(cyclic.id), 'DEPENDENCY_CYCLE', 409);
    expect((err.context as { session_id: string }).session_id).toBe(cyclic.id);
    expect(await svc.requireSession(cyclic.id)).toMatchObject({ status: 'receiving' });
    // 未知前置 ref 同样拒绝（VALIDATION_FAILED 422）。
    await svc.reportDraft(cyclic.id, { ref: 'x', title: 'x', depends_on: ['ghost'] });
    await expectError(() => svc.finish(cyclic.id), 'VALIDATION_FAILED', 422);
    // 修好之后可正常收尾。
    await svc.reportDraft(cyclic.id, { ref: 'x', title: 'x' });
    await svc.finish(cyclic.id);
    await svc.cancel(cyclic.id);
    expect(await svc.requireSession(cyclic.id)).toMatchObject({ status: 'cancelled' });
  });
});
