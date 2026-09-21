import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestApp, errorCode, type Sender, type TestApp } from '../../__tests__/helpers/http-app';
import { API, uiSender } from '../../__tests__/helpers/seed';

/**
 * v0.0.4 #19 ③ 技能引用循环检测：子技能块 skillRef 成环 / 自引用在写入路径
 * （PATCH content、POST versions）被拦截。就近错误码 SKILL_REF_SELF(400) /
 * SKILL_REF_CYCLE(409)（见 skill-reference.ts，待归位 contract/errors）。
 */

function refContent(targetId: string) {
  return {
    blocks: [{ id: 'sub', kind: 'subskill', title: '子技能', skillRef: targetId }],
    entryBlockId: 'sub',
  };
}

async function newSkill(ui: Sender, name: string) {
  const res = await ui.post(`${API}/skills`, {
    name,
    type: 'flow',
    description: '',
    tags: [],
    content: { blocks: [{ id: 'p', kind: 'prompt', title: '', prompt: 'x' }], entryBlockId: 'p' },
  });
  if (res.status !== 201) throw new Error(`建技能失败：${res.status} ${res.text}`);
  return res.body as { id: string };
}

describe('技能引用循环检测（③）', () => {
  let t: TestApp;
  let ui: Sender;

  beforeAll(async () => {
    t = await createTestApp();
    ui = uiSender(t);
  });

  afterAll(async () => {
    await t.close();
  });

  it('自引用：patch 把子技能块指向自己 → 400 SKILL_REF_SELF', async () => {
    const a = await newSkill(ui, '自引用甲');
    const res = await ui.patch(`${API}/skills/${a.id}`, { content: refContent(a.id) });
    expect(res.status).toBe(400);
    expect(errorCode(res)).toBe('SKILL_REF_SELF');
    expect(res.body.error.skill_id).toBe(a.id);
  });

  it('成环：A→B 放行，再让 B→A 回指 → 409 SKILL_REF_CYCLE（chain 含两端）', async () => {
    const a = await newSkill(ui, '环A');
    const b = await newSkill(ui, '环B');
    // A→B：此时 B 无出边，无环，正常落库。
    const ok = await ui.patch(`${API}/skills/${a.id}`, { content: refContent(b.id) });
    expect(ok.status).toBe(200);
    // B→A：B 的新出边 + A 已入库的出边构成 A→B→A。
    const back = await ui.patch(`${API}/skills/${b.id}`, { content: refContent(a.id) });
    expect(back.status).toBe(409);
    expect(errorCode(back)).toBe('SKILL_REF_CYCLE');
    expect(back.body.error.chain).toContain(a.id);
    expect(back.body.error.chain).toContain(b.id);
  });

  it('createVersion 同样验图：发布引用回指成环 → 409', async () => {
    const x = await newSkill(ui, '版X');
    const y = await newSkill(ui, '版Y');
    await ui.patch(`${API}/skills/${x.id}`, { content: refContent(y.id) });
    const res = await ui.post(`${API}/skills/${y.id}/versions`, { content: refContent(x.id) });
    expect(res.status).toBe(409);
    expect(errorCode(res)).toBe('SKILL_REF_CYCLE');
  });

  it('合法链不误伤：A→B→C（无回边）逐级放行', async () => {
    const a = await newSkill(ui, '链A');
    const b = await newSkill(ui, '链B');
    const c = await newSkill(ui, '链C');
    expect((await ui.patch(`${API}/skills/${b.id}`, { content: refContent(c.id) })).status).toBe(200);
    expect((await ui.patch(`${API}/skills/${a.id}`, { content: refContent(b.id) })).status).toBe(200);
  });

  it('三跳成环：C→A 闭合 A→B→C → 409', async () => {
    const a = await newSkill(ui, '跳A');
    const b = await newSkill(ui, '跳B');
    const c = await newSkill(ui, '跳C');
    await ui.patch(`${API}/skills/${a.id}`, { content: refContent(b.id) });
    await ui.patch(`${API}/skills/${b.id}`, { content: refContent(c.id) });
    const res = await ui.patch(`${API}/skills/${c.id}`, { content: refContent(a.id) });
    expect(res.status).toBe(409);
    expect(errorCode(res)).toBe('SKILL_REF_CYCLE');
  });
});
