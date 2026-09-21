import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ApiException } from '../../contract/errors';
import { EventsService, type WsEvent } from '../../infra/events.service';
import { createTestApp, type TestApp } from '../../__tests__/helpers/http-app';
import { uiSender } from '../../__tests__/helpers/seed';
import { BreakdownService, type BreakdownDraftInput } from '../breakdown.service';

/**
 * v0.0.4 工单 #34（B 口径）：`board.report_task_draft` 的服务层守卫放宽。
 * 原口径「会话必须 receiving」改为：
 *   receiving → 行为不变；
 *   reviewing 且该 ref 挂着 §7.4「重新生成」的 regeneration_pending 哨兵 → 整行覆盖（哨兵随覆盖消失）；
 *   reviewing 其余情形（无哨兵的老 ref、reviewing 期新增 ref）→ 仍 409 BREAKDOWN_BAD_STATE；
 *   completed / interrupted 等终态 → 一律不变。
 */
let t: TestApp;
let svc: BreakdownService;
let ui: ReturnType<typeof uiSender>;

beforeAll(async () => {
  t = await createTestApp();
  svc = t.app.get(BreakdownService);
  ui = uiSender(t);
});

afterAll(async () => {
  await t?.close();
});

/** 造一个 reviewing 会话：begin → d1 + d2（d2 依赖 d1）→ finish。 */
async function reviewingSession(title = `重报会话 ${Math.random().toString(36).slice(2, 8)}`) {
  const session = await svc.begin({ requirement_text: `${title} 的需求原文`, parent_title: title });
  const drafts: BreakdownDraftInput[] = [
    { ref: 'd1', title: `${title} · 数据模型`, acceptance: ['原验收条目'] },
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

function collectEvents(): { list: WsEvent[]; stop: () => void } {
  const events = t.app.get(EventsService, { strict: false });
  const list: WsEvent[] = [];
  return { list, stop: events.registerSink((event: WsEvent) => list.push(event)) };
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

describe('reportDraft × reviewing + 哨兵：单草案重报放行（#34 B 口径）', () => {
  it('成功：整行覆盖 agent 字段、哨兵消失、广播既有 breakdown.task_draft', async () => {
    const session = await reviewingSession();
    await svc.userRegenerateDraft(session.id, 'd1');
    expect((await svc.get(session.id)).drafts.find((d) => d.ref === 'd1')?.regeneration_pending).toBe(true);

    const { list, stop } = collectEvents();
    const dto = await svc.reportDraft(session.id, {
      ref: 'd1',
      title: 'Agent 重报的标题',
      description: '重报带来的描述',
      priority: 1,
      acceptance: ['重报验收一', '重报验收二'],
      depends_on: ['d2'],
      sort_order: 4,
    });
    stop();

    expect(dto).toMatchObject({
      ref: 'd1',
      title: 'Agent 重报的标题',
      description: '重报带来的描述',
      priority: 1,
      acceptance: ['重报验收一', '重报验收二'],
      depends_on: ['d2'],
      sort_order: 4,
    });
    // 读侧真相：depends_on 以 agent 上报为准，哨兵随覆盖消失。
    const detail = await svc.get(session.id);
    const d1 = detail.drafts.find((d) => d.ref === 'd1');
    expect(d1).toMatchObject({ title: 'Agent 重报的标题', depends_on: ['d2'] });
    expect(d1?.regeneration_pending).toBeUndefined();
    // 草案不增行：actual_tasks 不变。
    expect(detail.session.actual_tasks).toBe(2);
    expect(
      list.filter((e) => e.event === 'breakdown.task_draft' && e.data.session_id === session.id && e.data.ref === 'd1'),
    ).toHaveLength(1);
  });

  it('成功：skill_ids 走既有解析路径（reviewing 已过 finish，名字就地落定成 id）', async () => {
    const skillName = `重报解析技能-${Math.random().toString(36).slice(2, 8)}`;
    const skillId = await createSkill(skillName);
    const session = await reviewingSession();
    await svc.userRegenerateDraft(session.id, 'd1');
    await svc.reportDraft(session.id, { ref: 'd1', title: '带技能的重报', skill_ids: [skillName] });

    const detail = await svc.get(session.id);
    const d1 = detail.drafts.find((d) => d.ref === 'd1');
    expect(d1?.skill_ids).toEqual([skillId]);
    expect(d1?.skills_status).toEqual([
      { value: skillId, state: 'resolved', skill_id: skillId, name: expect.any(String), candidates: [skillId] },
    ]);
    // 覆盖后可确认，且技能真的建到任务上（confirm 侧只认 id，解析没做就会静默丢）。
    const confirmed = await svc.confirm(session.id);
    const task = await t.prisma.task.findUnique({ where: { id: confirmed.task_ids[0]! } });
    expect(JSON.parse((task?.skills ?? '[]') as string)).toEqual([skillId]);
  });

  it('拒绝：无哨兵的 ref（含 reviewing 期新增 ref）仍 409，行内容一字不动', async () => {
    const session = await reviewingSession();
    const before = await svc.get(session.id);

    const err = await expectError(
      () => svc.reportDraft(session.id, { ref: 'd2', title: '想抢改人工编辑的草案' }),
      'BREAKDOWN_BAD_STATE',
      409,
    );
    // 错误信息与放宽前逐字一致（同一 assertStatus 出口）。
    expect(err.message).toBe('拆解会话当前状态「reviewing」不允许该操作（需要：receiving）');
    expect(err.context).toMatchObject({ session_id: session.id, status: 'reviewing', allowed: ['receiving'] });

    const late = await expectError(
      () => svc.reportDraft(session.id, { ref: 'd9', title: 'reviewing 期塞新草案' }),
      'BREAKDOWN_BAD_STATE',
      409,
    );
    expect(late.code).toBe('BREAKDOWN_BAD_STATE');

    const after = await svc.get(session.id);
    expect(after.drafts).toEqual(before.drafts);
  });

  it('不变：receiving 期行为照旧（同 ref 覆盖 + 新 ref 可建）', async () => {
    const session = await svc.begin({ requirement_text: '还在拆', parent_title: 'receiving 回归' });
    await svc.reportDraft(session.id, { ref: 'a', title: '甲', skill_ids: ['未解析名'] });
    const revised = await svc.reportDraft(session.id, { ref: 'a', title: '甲（修订）', skill_ids: ['未解析名'] });
    expect(revised).toMatchObject({ title: '甲（修订）' });
    // receiving 期不做就地解析：未解析名原样保留，仍由 finish 统一转 id（§7.5）。
    expect((await svc.get(session.id)).drafts.find((d) => d.ref === 'a')?.skill_ids).toEqual(['未解析名']);
    const created = await svc.reportDraft(session.id, { ref: 'b', title: '乙' });
    expect(created.ref).toBe('b');
    expect((await svc.get(session.id)).drafts.map((d) => d.ref)).toEqual(['a', 'b']);
  });

  it('不变：终态一律拒绝（completed 确认后再重报、interrupted 带哨兵也不放行）', async () => {
    const done = await reviewingSession();
    await svc.userRegenerateDraft(done.id, 'd1');
    await svc.confirm(done.id);
    await expectError(
      () => svc.reportDraft(done.id, { ref: 'd1', title: '确认之后才来的重报' }),
      'BREAKDOWN_BAD_STATE',
      409,
    );
    const stillPending = await svc.get(done.id);
    expect(stillPending.drafts.find((d) => d.ref === 'd1')?.regeneration_pending).toBe(true);

    const interrupted = await reviewingSession();
    await svc.userRegenerateDraft(interrupted.id, 'd1');
    await t.prisma.$executeRawUnsafe(`UPDATE breakdown_sessions SET status = 'interrupted' WHERE id = ?`, interrupted.id);
    await expectError(
      () => svc.reportDraft(interrupted.id, { ref: 'd1', title: '中断会话的重报' }),
      'BREAKDOWN_BAD_STATE',
      409,
    );
    expect((await svc.get(interrupted.id)).drafts.find((d) => d.ref === 'd1')?.title).toBe('（待重新生成）');
  });
});
