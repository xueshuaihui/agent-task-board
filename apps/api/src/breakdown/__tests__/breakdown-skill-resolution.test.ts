import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { BreakdownService, type SkillStatusEntry } from '../breakdown.service';
import { createTestApp, type Sender, type TestApp } from '../../__tests__/helpers/http-app';
import { API, uiSender } from '../../__tests__/helpers/seed';

/**
 * W7 遗留 b2 / 条款 81：GET /breakdown/sessions/{id} 透出技能解析载荷——
 * finish 内部算的那份（resolved id / ambiguous 候选 / unresolved 原样）必须读得到，
 * 且 finish 把名字落成 id 之后歧义标注不丢（确认页可见可改的前置）。
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

describe('GET 详情 skill 解析载荷（receiving 期即预解析，finish 前后口径一致）', () => {
  it('resolved/ambiguous/unresolved 三态齐活，且 finish 转 id 后歧义仍可见', async () => {
    const salt = Math.random().toString(36).slice(2, 8);
    const soloName = `解析-独苗-${salt}`;
    const twinName = `解析-同名-${salt}`;
    const missingName = `解析-查无-${salt}`;
    const soloId = await createSkill(soloName);
    const twinOld = await createSkill(twinName);
    const twinNew = await createSkill(twinName); // 后创建者 = 「最近更新者」，应落定它

    const session = await svc.begin({ requirement_text: '解析载荷验证', parent_title: `解析载荷 ${salt}` });
    await svc.reportDraft(session.id, { ref: 'd1', title: '按名字命中', skill_ids: [soloName] });
    await svc.reportDraft(session.id, { ref: 'd2', title: '同名歧义', skill_ids: [twinName] });
    await svc.reportDraft(session.id, { ref: 'd3', title: '查无此技能', skill_ids: [missingName] });
    await svc.reportDraft(session.id, { ref: 'd4', title: '无技能' });

    // ---- finish 前（receiving）：名字形态的三态
    const before = await svc.get(session.id);
    expect(before.skill_resolution).toEqual({
      ambiguous: [{ ref: 'd2', name: twinName, skill_id: twinNew, candidates: [twinNew, twinOld] }],
      unresolved: [{ ref: 'd3', name: missingName }],
    });
    expect(statusOf(before, 'd1')).toEqual([
      { value: soloName, state: 'resolved', skill_id: soloId, name: soloName, candidates: [soloId] },
    ]);
    expect(statusOf(before, 'd2')[0]).toMatchObject({ state: 'ambiguous', skill_id: twinNew });
    expect(statusOf(before, 'd3')).toEqual([
      { value: missingName, state: 'unresolved', skill_id: null, name: missingName, candidates: [] },
    ]);
    expect(statusOf(before, 'd4')).toEqual([]);

    await svc.finish(session.id);

    // ---- finish 后（reviewing）：d1/d2 已落成 id，d3 原样保留名字
    const after = await svc.get(session.id);
    expect(statusOf(after, 'd1')).toEqual([
      { value: soloId, state: 'resolved', skill_id: soloId, name: soloName, candidates: [soloId] },
    ]);
    // 条款 81 关键点：草案里存的已是落定 id，同名歧义仍按技能名复原、可见可改。
    expect(statusOf(after, 'd2')[0]).toEqual({
      value: twinNew,
      state: 'ambiguous',
      skill_id: twinNew,
      name: twinName,
      candidates: [twinNew, twinOld],
    });
    expect(after.skill_resolution.unresolved).toEqual([{ ref: 'd3', name: missingName }]);
    expect(after.drafts.find((d) => d.ref === 'd3')!.skill_ids).toEqual([missingName]);

    // ---- REST 面同形状透出（确认页数据源就是这条端点）
    const res = await ui.get(`${API}/breakdown/sessions/${session.id}`);
    expect(res.status).toBe(200);
    expect(res.body.skill_resolution.ambiguous).toHaveLength(1);
    expect(res.body.skill_resolution.ambiguous[0]).toMatchObject({ ref: 'd2', skill_id: twinNew });
    expect(res.body.drafts.find((d: { ref: string }) => d.ref === 'd2').skills_status[0].candidates).toHaveLength(2);
  });

  it('无技能草案：报告两数组为空，不额外查库出错', async () => {
    const session = await svc.begin({ requirement_text: '空技能', parent_title: '空解析' });
    await svc.reportDraft(session.id, { ref: 'd1', title: '裸草案' });
    const detail = await svc.get(session.id);
    expect(detail.skill_resolution).toEqual({ ambiguous: [], unresolved: [] });
    expect(detail.drafts[0]!.skills_status).toEqual([]);
  });
});
