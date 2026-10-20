import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ApiException } from '../../contract/errors';
import { EventsService, type WsEvent } from '../../infra/events.service';
import { createTestApp, errorCode, type Sender, type TestApp } from '../../__tests__/helpers/http-app';
import { API, uiSender } from '../../__tests__/helpers/seed';
import { BreakdownService } from '../breakdown.service';

/**
 * #4 拆解重生成闭环（后端主片）：
 *   revision 递增、单草案/整份重生成带 note、待重生成时 finish/confirm 硬守卫、
 *   列表 scope/归档过滤与 keyset 分页、旧 depends_on JSON 哨兵的只读兼容。
 */
let t: TestApp;
let svc: BreakdownService;
let u: Sender;

beforeAll(async () => {
  t = await createTestApp();
  svc = t.app.get(BreakdownService);
  u = uiSender(t);
}, 30_000);

afterAll(async () => {
  await t?.close();
});

const suffix = () => Math.random().toString(36).slice(2, 8);

interface SessionDto {
  id: string;
  parent_title: string;
  status: string;
  revision: number;
  revision_note: string | null;
  revision_requested_at: string | null;
  actual_tasks: number | null;
  finished_at: string | null;
  parent_task_id: string | null;
}

interface DraftDto {
  ref: string;
  title: string;
  description: string | null;
  depends_on: string[];
  regeneration_pending?: boolean;
  regeneration_note?: string | null;
  regeneration_requested_at?: string | null;
}

interface DetailDto {
  session: SessionDto;
  drafts: DraftDto[];
}

async function beginSession(title = `#4 会话 ${suffix()}`): Promise<SessionDto> {
  return (await svc.begin({ requirement_text: `${title} 的需求原文`, parent_title: title })) as SessionDto;
}

/** 造一个 reviewing 会话：begin → d1 + d2（d2 依赖 d1）→ finish。 */
async function reviewingSession(title = `#4 待确认 ${suffix()}`): Promise<SessionDto> {
  const session = await beginSession(title);
  await svc.reportDraft(session.id, { ref: 'd1', title: `${title} · 数据模型`, acceptance: ['原验收'] });
  await svc.reportDraft(session.id, { ref: 'd2', title: `${title} · 接口`, depends_on: ['d1'] });
  await svc.finish(session.id);
  return session;
}

async function revisionOf(sessionId: string): Promise<number> {
  return (await svc.requireSession(sessionId)).revision;
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

describe('#4 revision：会改变会话内容的写操作逐次 +1', () => {
  it('begin=0；reportDraft/reportProgress/finish/userUpdateDraft/cancel 递增；confirm 也递增', async () => {
    const session = await beginSession();
    expect(session.revision).toBe(0);

    await svc.reportDraft(session.id, { ref: 'd1', title: '草案一' });
    expect(await revisionOf(session.id)).toBe(1);

    await svc.reportProgress(session.id, { step: 1, total: 2 });
    expect(await revisionOf(session.id)).toBe(2);

    // 同 ref 覆盖上报同样算一次内容写。
    await svc.reportDraft(session.id, { ref: 'd1', title: '草案一（修订）' });
    expect(await revisionOf(session.id)).toBe(3);

    await svc.finish(session.id);
    expect(await revisionOf(session.id)).toBe(4);

    await svc.userUpdateDraft(session.id, 'd1', { title: '用户改标题' });
    expect(await revisionOf(session.id)).toBe(5);

    await svc.cancel(session.id);
    expect(await revisionOf(session.id)).toBe(6);

    const toConfirm = await reviewingSession();
    const beforeConfirm = await revisionOf(toConfirm.id);
    const confirmed = await svc.confirm(toConfirm.id);
    expect(confirmed.session.revision).toBe(beforeConfirm + 1);
  });
});

describe('单草案重生成（带说明）与 confirm 硬守卫', () => {
  it('pending/note/requested_at 落库、depends_on 清空、revision+1、事件与 confirm 409', async () => {
    const session = await reviewingSession();
    const before = await revisionOf(session.id); // 2 次 reportDraft + 1 次 finish = 3
    expect(before).toBe(3);

    const events = collectEvents();
    const res = await u.post(`${API}/breakdown/sessions/${session.id}/drafts/d1/regenerate`, {
      note: '  请把数据模型拆细  ',
    });
    events.stop();

    expect(res.status).toBe(201);
    const d1 = (res.body as DraftDto[]).find((draft) => draft.ref === 'd1')!;
    expect(d1).toMatchObject({
      title: '（待重新生成）',
      description: null,
      depends_on: [],
      regeneration_pending: true,
      regeneration_note: '请把数据模型拆细',
      regeneration_requested_at: expect.any(String),
    });
    expect(await revisionOf(session.id)).toBe(before + 1);

    const detail = (await svc.get(session.id)) as DetailDto;
    expect(detail.drafts.find((draft) => draft.ref === 'd1')).toMatchObject({
      regeneration_pending: true,
      regeneration_note: '请把数据模型拆细',
      regeneration_requested_at: expect.any(String),
      depends_on: [],
    });
    // 重置不删行：d2 指向 d1 的依赖边仍在。
    expect(detail.drafts.find((draft) => draft.ref === 'd2')?.depends_on).toEqual(['d1']);

    const revisionEvent = events.list.find((event) => event.event === 'breakdown.revision_requested');
    expect(revisionEvent?.data).toEqual({
      session_id: session.id,
      scope: 'draft',
      refs: ['d1'],
      note: '请把数据模型拆细',
    });
    expect(events.list.some((event) => event.event === 'breakdown.task_draft' && event.data.ref === 'd1')).toBe(true);

    const confirm = await u.post(`${API}/breakdown/sessions/${session.id}/confirm`);
    expect(confirm.status).toBe(409);
    expect(errorCode(confirm)).toBe('BREAKDOWN_REGENERATION_PENDING');
    const error = (confirm.body as { error: { session_id: string; refs: string[] } }).error;
    expect(error.session_id).toBe(session.id);
    expect(error.refs).toEqual(['d1']);
  });

  it('note 规整：空白串 → null；超 2000 字被 422 挡下', async () => {
    const session = await reviewingSession();
    const blank = await u.post(`${API}/breakdown/sessions/${session.id}/drafts/d1/regenerate`, { note: '   ' });
    expect(blank.status).toBe(201);
    const d1 = (blank.body as DraftDto[]).find((draft) => draft.ref === 'd1')!;
    expect(d1.regeneration_note).toBeNull();
    expect(d1.regeneration_requested_at).toEqual(expect.any(String));

    const tooLong = await u.post(`${API}/breakdown/sessions/${session.id}/drafts/d2/regenerate`, {
      note: 'x'.repeat(2001),
    });
    expect(tooLong.status).toBe(422);
    expect(errorCode(tooLong)).toBe('VALIDATION_FAILED');
    // 校验失败不落库：d2 仍不是待重报。
    const detail = (await svc.get(session.id)) as DetailDto;
    expect(detail.drafts.find((draft) => draft.ref === 'd2')?.regeneration_pending).toBeUndefined();
  });

  it('Agent 重报该 ref 后 pending/note/requested_at 清零，confirm 放行', async () => {
    const session = await reviewingSession();
    await u.post(`${API}/breakdown/sessions/${session.id}/drafts/d1/regenerate`, { note: '需要重写' });

    const replay = await svc.reportDraft(session.id, {
      ref: 'd1',
      title: '重报后的数据模型',
      description: '重报带来的描述',
      depends_on: [],
    });
    expect(replay.regeneration_pending).toBeUndefined();

    const detail = (await svc.get(session.id)) as DetailDto;
    const d1 = detail.drafts.find((draft) => draft.ref === 'd1')!;
    expect(d1).toMatchObject({ title: '重报后的数据模型', description: '重报带来的描述' });
    expect(d1.regeneration_pending).toBeUndefined();
    expect(d1.regeneration_note).toBeUndefined();
    expect(d1.regeneration_requested_at).toBeUndefined();

    const columns = await t.prisma.$queryRawUnsafe<
      { regeneration_pending: number; regeneration_note: string | null; regeneration_requested_at: string | null }[]
    >(
      `SELECT regeneration_pending, regeneration_note, regeneration_requested_at
         FROM breakdown_drafts WHERE session_id = ? AND ref = 'd1'`,
      session.id,
    );
    expect(columns[0]).toMatchObject({
      regeneration_pending: 0,
      regeneration_note: null,
      regeneration_requested_at: null,
    });

    const confirmed = await svc.confirm(session.id);
    expect(confirmed.session.status).toBe('completed');
    expect(confirmed.task_ids).toHaveLength(2);
    const task = await t.prisma.task.findUnique({ where: { id: confirmed.task_ids[0]! } });
    expect(task?.title).toBe('重报后的数据模型');
  });
});

describe('整份会话重生成（scope=session）', () => {
  it('reviewing → receiving，全草案 pending + note/revision；未重报完成时 finish 409，逐条重报后放行', async () => {
    const session = await reviewingSession();
    const before = await revisionOf(session.id);
    const events = collectEvents();
    const res = await u.post(`${API}/breakdown/sessions/${session.id}/regenerate`, {
      note: '按新方案整体重拆',
    });
    events.stop();

    expect(res.status).toBe(201);
    const body = res.body as DetailDto;
    expect(body.session).toMatchObject({
      status: 'receiving',
      revision_note: '按新方案整体重拆',
      revision_requested_at: expect.any(String),
      finished_at: null,
    });
    expect(body.session.revision).toBe(before + 1);
    expect(body.drafts).toHaveLength(2);
    for (const draft of body.drafts) {
      expect(draft).toMatchObject({
        title: '（待重新生成）',
        description: null,
        depends_on: [],
        regeneration_pending: true,
        regeneration_note: '按新方案整体重拆',
        regeneration_requested_at: expect.any(String),
      });
    }

    const revisionEvent = events.list.find((event) => event.event === 'breakdown.revision_requested');
    expect(revisionEvent?.data).toEqual({
      session_id: session.id,
      scope: 'session',
      refs: ['d1', 'd2'],
      note: '按新方案整体重拆',
    });
    const audit = await t.prisma.auditLog.findMany({
      where: { action: 'breakdown_regenerate', targetId: session.id },
    });
    expect(audit).toHaveLength(1);
    expect(JSON.parse(audit[0]!.before as string)).toEqual({ status: 'reviewing' });
    expect(JSON.parse(audit[0]!.after as string)).toEqual({ status: 'receiving', note: '按新方案整体重拆' });

    // Agent 用新 ref 补报新方案，但旧 d1/d2 未销账——finish 必须 409 并列出 refs。
    await svc.reportDraft(session.id, { ref: 'n1', title: '新方案 · 单任务' });
    const blocked = await expectError(
      () => svc.finish(session.id),
      'BREAKDOWN_REGENERATION_PENDING',
      409,
    );
    expect(blocked.context.refs).toEqual(['d1', 'd2']);

    // 逐条重报旧 ref 后放行，confirm 建出全部三条。
    await svc.reportDraft(session.id, { ref: 'd1', title: '新方案 · 数据模型' });
    await svc.reportDraft(session.id, { ref: 'd2', title: '新方案 · 接口', depends_on: ['d1'] });
    const finished = await svc.finish(session.id);
    expect(finished.session.status).toBe('reviewing');
    expect(finished.session.actual_tasks).toBe(3);
    expect((await svc.get(session.id)).drafts.map((draft) => draft.ref).sort()).toEqual([
      'd1',
      'd2',
      'n1',
    ]);

    const confirmed = await svc.confirm(session.id);
    expect(confirmed.task_ids).toHaveLength(3);
    const titles = await Promise.all(
      confirmed.task_ids.map(async (id) => (await t.prisma.task.findUnique({ where: { id } }))?.title),
    );
    expect(new Set(titles)).toEqual(new Set(['新方案 · 单任务', '新方案 · 数据模型', '新方案 · 接口']));
  });

  it('未重报任何草案就 finish：409 列出全部 refs，会话保持 receiving 且草案原样保留', async () => {
    const session = await reviewingSession();
    await svc.regenerateSession(session.id, '没有重报');

    const blocked = await expectError(
      () => svc.finish(session.id),
      'BREAKDOWN_REGENERATION_PENDING',
      409,
    );
    expect(blocked.context.refs).toEqual(['d1', 'd2']);
    const detail = (await svc.get(session.id)) as DetailDto;
    expect(detail.session.status).toBe('receiving');
    expect(detail.drafts).toHaveLength(2);
    expect(detail.drafts.every((draft) => draft.regeneration_pending === true)).toBe(true);
  });

  it('错误：receiving 会话整份重生成回 409 BREAKDOWN_BAD_STATE', async () => {
    const receiving = await beginSession();
    await expectError(() => svc.regenerateSession(receiving.id), 'BREAKDOWN_BAD_STATE', 409);
  });
});

describe('列表过滤与分页（GET /breakdown/sessions）', () => {
  it('scope=active/history/all 各取所需', async () => {
    const activeReceiving = await beginSession(`列表 active 接收 ${suffix()}`);
    const activeReviewing = await reviewingSession(`列表 active 待确认 ${suffix()}`);
    const completedSession = await reviewingSession(`列表 history 完成 ${suffix()}`);
    await svc.confirm(completedSession.id);
    const cancelled = await beginSession(`列表 history 取消 ${suffix()}`);
    await svc.cancel(cancelled.id);

    const active = await svc.list({ scope: 'active', limit: 500 });
    const activeIds = new Set(active.map((row) => row.id));
    expect(activeIds.has(activeReceiving.id)).toBe(true);
    expect(activeIds.has(activeReviewing.id)).toBe(true);
    expect(activeIds.has(completedSession.id)).toBe(false);
    expect(activeIds.has(cancelled.id)).toBe(false);
    for (const row of active) expect(['receiving', 'reviewing', 'creating']).toContain(row.status);

    const history = await svc.list({ scope: 'history', limit: 500 });
    const historyIds = new Set(history.map((row) => row.id));
    expect(historyIds.has(completedSession.id)).toBe(true);
    expect(historyIds.has(cancelled.id)).toBe(true);
    expect(historyIds.has(activeReceiving.id)).toBe(false);
    expect(historyIds.has(activeReviewing.id)).toBe(false);
    for (const row of history) expect(['completed', 'cancelled', 'interrupted']).toContain(row.status);

    const all = await svc.list({ scope: 'all', limit: 500 });
    const allIds = new Set(all.map((row) => row.id));
    for (const id of [activeReceiving.id, activeReviewing.id, completedSession.id, cancelled.id]) {
      expect(allIds.has(id)).toBe(true);
    }
  });

  it('include_archived：默认排除父需求已归档的会话，true 才带出；requirement_id 精确过滤', async () => {
    const archivedSession = await reviewingSession(`归档父需求 ${suffix()}`);
    const confirmedArchive = await svc.confirm(archivedSession.id);
    const parentId = confirmedArchive.parent_task_id;
    // 任务的归档谓词是 archived_at（status CHECK 里没有 ARCHIVED 词），与 TasksService.archive 同口径。
    await t.prisma.$executeRawUnsafe(
      `UPDATE tasks SET archived_at = datetime('now') WHERE id = ?`,
      parentId,
    );

    const otherSession = await reviewingSession(`未归档对照 ${suffix()}`);
    const confirmedOther = await svc.confirm(otherSession.id);

    expect(await svc.list({ requirement_id: parentId })).toEqual([]);
    const withArchived = await svc.list({ requirement_id: parentId, include_archived: true });
    expect(withArchived.map((row) => row.id)).toEqual([archivedSession.id]);

    // requirement_id 精确命中（未归档的父需求照常返回）。
    const onlyOther = await svc.list({ requirement_id: confirmedOther.parent_task_id });
    expect(onlyOther.map((row) => row.id)).toEqual([otherSession.id]);

    // REST query 层：include_archived=false 不能被 coerce 成 true。
    const hidden = await u.get(
      `${API}/breakdown/sessions?requirement_id=${encodeURIComponent(parentId!)}&include_archived=false`,
    );
    expect(hidden.status).toBe(200);
    expect(hidden.body).toEqual([]);
    const shown = await u.get(
      `${API}/breakdown/sessions?requirement_id=${encodeURIComponent(parentId!)}&include_archived=true`,
    );
    expect(shown.status).toBe(200);
    expect((shown.body as SessionDto[]).map((row) => row.id)).toEqual([archivedSession.id]);
  });

  it('limit 与 cursor keyset 翻页：无重复、无遗漏；非法 cursor 422', async () => {
    for (let index = 0; index < 3; index += 1) await beginSession(`翻页会话 ${index} ${suffix()}`);

    const all = await svc.list({ limit: 500 });
    expect(all.length).toBeGreaterThanOrEqual(5);

    const page1 = await svc.list({ limit: 2 });
    expect(page1.map((row) => row.id)).toEqual(all.slice(0, 2).map((row) => row.id));
    const page2 = await svc.list({ limit: 2, cursor: page1[1]!.id });
    expect(page2.map((row) => row.id)).toEqual(all.slice(2, 4).map((row) => row.id));
    const page3 = await svc.list({ limit: 2, cursor: page2[1]!.id });
    expect(page3.map((row) => row.id)).toEqual(all.slice(4, 6).map((row) => row.id));

    const seen = [...page1, ...page2, ...page3].map((row) => row.id);
    expect(new Set(seen).size).toBe(seen.length);
    expect(seen).toEqual(all.slice(0, seen.length).map((row) => row.id));

    await expectError(() => svc.list({ cursor: 'no-such-session' }), 'INVALID_PARAM', 422);
  });

  it('REST query 校验：scope 词表外 422；limit 上限 422', async () => {
    expect((await u.get(`${API}/breakdown/sessions?scope=nope`)).status).toBe(422);
    expect((await u.get(`${API}/breakdown/sessions?limit=501`)).status).toBe(422);
    const ok = await u.get(`${API}/breakdown/sessions?scope=active&limit=1`);
    expect(ok.status).toBe(200);
    expect(ok.body).toHaveLength(1);
  });
});

describe('旧 depends_on JSON 哨兵的只读兼容', () => {
  it('旧哨兵行详情仍报 pending（note/requested_at 为 null），confirm 409；Agent 重报后销账', async () => {
    const session = await reviewingSession();
    await t.prisma.$executeRawUnsafe(
      `UPDATE breakdown_drafts
          SET depends_on = ?, regeneration_pending = 0, regeneration_note = NULL, regeneration_requested_at = NULL
        WHERE session_id = ? AND ref = 'd1'`,
      JSON.stringify({ regeneration_pending: true }),
      session.id,
    );

    const detail = (await svc.get(session.id)) as DetailDto;
    const d1 = detail.drafts.find((draft) => draft.ref === 'd1')!;
    expect(d1.regeneration_pending).toBe(true);
    expect(d1.regeneration_note).toBeNull();
    expect(d1.regeneration_requested_at).toBeNull();
    expect(d1.depends_on).toEqual([]);

    const confirm = await u.post(`${API}/breakdown/sessions/${session.id}/confirm`);
    expect(confirm.status).toBe(409);
    expect(errorCode(confirm)).toBe('BREAKDOWN_REGENERATION_PENDING');
    expect((confirm.body as { error: { refs: string[] } }).error.refs).toEqual(['d1']);

    // reviewing 期的旧哨兵重报仍走 #34 放行路径，depends_on 写回纯数组。
    await svc.reportDraft(session.id, { ref: 'd1', title: '旧哨兵重报' });
    const columns = await t.prisma.$queryRawUnsafe<{ depends_on: string; regeneration_pending: number }[]>(
      `SELECT depends_on, regeneration_pending FROM breakdown_drafts WHERE session_id = ? AND ref = 'd1'`,
      session.id,
    );
    expect(JSON.parse(columns[0]!.depends_on)).toEqual([]);
    expect(columns[0]!.regeneration_pending).toBe(0);

    const confirmed = await svc.confirm(session.id);
    expect(confirmed.session.status).toBe('completed');
  });
});
