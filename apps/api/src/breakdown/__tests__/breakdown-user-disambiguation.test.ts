import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { BreakdownService, type SkillStatusEntry } from '../breakdown.service';
import { createTestApp, type Sender, type TestApp } from '../../__tests__/helpers/http-app';
import { API, uiSender } from '../../__tests__/helpers/seed';

/**
 * v0.0.4 工单 #35 / 裁定 3（2026-09-21「重选即消歧」）：用户在确认页把技能重选为
 * 显式 skill_id（PATCH skill_ids 全为真实 id）→ 该行落 user_disambiguated 标记，
 * 读侧不再把同名碰撞标 ambiguous、不进 skill_resolution；confirm 建任务落用户选的 id。
 * agent 名字上报路径的歧义标注（条款 81 / b2）一字不动；#34 哨兵 B 通道整行重报
 * 时标记随覆盖消失，回到名字碰撞解析原语义。
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

async function createSkill(name: string): Promise<string> {
  const res = await ui.post('/api/v1/skills', { name, type: 'workflow' });
  if (res.status !== 201) throw new Error(`建技能失败：${res.status} ${res.text}`);
  return res.body.id as string;
}

function statusOf(detail: Awaited<ReturnType<BreakdownService['get']>>, ref: string): SkillStatusEntry[] {
  const draft = detail.drafts.find((d) => d.ref === ref);
  return draft?.skills_status ?? [];
}

/** begin → d1/d2 都按名字上报同名技能 → finish：两条都该是 ambiguous（b2 基线）。 */
async function twinCollisionSession(title: string) {
  const twinName = `重选-同名-${Math.random().toString(36).slice(2, 8)}`;
  const twinOld = await createSkill(twinName);
  const twinNew = await createSkill(twinName); // 后创建者 = 「最近更新者」，finish 落定它
  const session = await svc.begin({ requirement_text: `${title} 的需求原文`, parent_title: title });
  await svc.reportDraft(session.id, { ref: 'd1', title: `${title} · 重选条`, skill_ids: [twinName] });
  await svc.reportDraft(session.id, { ref: 'd2', title: `${title} · 未重选条`, skill_ids: [twinName] });
  await svc.finish(session.id);
  return { session, twinName, twinOld, twinNew };
}

describe('用户重选显式 id 即消歧（裁定 3）', () => {
  it('同名碰撞 finish 标 ambiguous；用户 PATCH 重选 id 后降为 resolved，confirm 落该 id', async () => {
    const { session, twinName, twinOld, twinNew } = await twinCollisionSession('重选消歧');
    const baseline = await svc.get(session.id);
    expect(baseline.skill_resolution.ambiguous.map((entry) => entry.ref)).toEqual(['d1', 'd2']);
    expect(statusOf(baseline, 'd1')[0]).toMatchObject({ state: 'ambiguous', skill_id: twinNew });

    const res = await ui.patch(`${API}/breakdown/sessions/${session.id}/drafts/d1`, { skill_ids: [twinOld] });
    expect(res.status).toBe(200);
    expect((res.body as { ref: string; user_disambiguated?: boolean }[]).find((d) => d.ref === 'd1')).toMatchObject({
      skill_ids: [twinOld],
      user_disambiguated: true,
    });

    const after = await svc.get(session.id);
    expect(statusOf(after, 'd1')).toEqual([
      { value: twinOld, state: 'resolved', skill_id: twinOld, name: twinName, candidates: [twinOld] },
    ]);
    // 报告里彻底退出：只剩未重选的 d2，且其候选/落定者维持 b2 原口径。
    expect(after.skill_resolution).toEqual({
      ambiguous: [{ ref: 'd2', name: twinName, skill_id: twinNew, candidates: [twinNew, twinOld] }],
      unresolved: [],
    });

    const confirmed = await svc.confirm(session.id);
    expect(confirmed.task_ids).toHaveLength(2);
    const task = await t.prisma.task.findFirst({ where: { id: { in: confirmed.task_ids }, title: '重选消歧 · 重选条' } });
    expect(JSON.parse((task?.skills ?? 'null') as string)).toEqual([twinOld]);
  });

  it('未重选的碰撞条目仍 ambiguous（b2 回归）；PATCH 传名字/查无值不标记、不消歧', async () => {
    const { session, twinNew } = await twinCollisionSession('不重选');
    // 只重选 d1：d2 的标注一字不动（上一条已锁，这里反向锁 d2 视角）。
    await ui.patch(`${API}/breakdown/sessions/${session.id}/drafts/d1`, { skill_ids: [twinNew] });
    const untouched = (await svc.get(session.id)).drafts.find((d) => d.ref === 'd2');
    expect(untouched?.skills_status?.[0]).toMatchObject({ state: 'ambiguous' });
    expect(untouched?.user_disambiguated).toBeUndefined();

    // PATCH 传的不是真实 id（未解析名字）→ 纯数组落列，无标记，状态走 unresolved。
    const missing = `查无-重选-${Math.random().toString(36).slice(2, 8)}`;
    const renamed = await ui.patch(`${API}/breakdown/sessions/${session.id}/drafts/d1`, { skill_ids: [missing] });
    expect((renamed.body as { ref: string; user_disambiguated?: boolean }[]).find((d) => d.ref === 'd1')).toMatchObject({
      skill_ids: [missing],
    });
    const after = await svc.get(session.id);
    expect(statusOf(after, 'd1')).toEqual([
      { value: missing, state: 'unresolved', skill_id: null, name: missing, candidates: [] },
    ]);
    expect(after.drafts.find((d) => d.ref === 'd1')?.user_disambiguated).toBeUndefined();
  });

  it('哨兵 B 通道重报整行覆盖：消歧标记消失，回到名字碰撞解析原语义', async () => {
    const { session, twinName, twinOld, twinNew } = await twinCollisionSession('重报回退');
    await ui.patch(`${API}/breakdown/sessions/${session.id}/drafts/d1`, { skill_ids: [twinOld] });
    expect((await svc.get(session.id)).drafts.find((d) => d.ref === 'd1')?.user_disambiguated).toBe(true);

    await svc.userRegenerateDraft(session.id, 'd1');
    const reset = (await svc.get(session.id)).drafts.find((d) => d.ref === 'd1');
    expect(reset).toMatchObject({ skill_ids: [], regeneration_pending: true });
    expect(reset?.user_disambiguated).toBeUndefined();

    // #34 通道：agent 重报同一名字，就地解析落定「最近更新者」，写回纯数组。
    await svc.reportDraft(session.id, { ref: 'd1', title: '重报回退 · 重选条', skill_ids: [twinName] });
    const after = await svc.get(session.id);
    const d1 = after.drafts.find((d) => d.ref === 'd1');
    expect(d1?.skill_ids).toEqual([twinNew]);
    expect(d1?.user_disambiguated).toBeUndefined();
    expect(statusOf(after, 'd1')[0]).toMatchObject({ state: 'ambiguous', skill_id: twinNew, candidates: [twinNew, twinOld] });
    expect(after.skill_resolution.ambiguous.map((entry) => entry.ref)).toEqual(['d1', 'd2']);
  });
});
