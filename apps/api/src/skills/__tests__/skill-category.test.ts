import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestApp, type Sender, type TestApp } from '../../__tests__/helpers/http-app';
import { API, uiSender } from '../../__tests__/helpers/seed';

/**
 * v0.0.4 分类收口 C-3：skills.category 单值列接入 api 读写面与 SKILL.md 导入导出。
 * 口径（PRD §9.2 / §21.4，0015 迁移）：
 * - create/patch 入参 category 走 11 词表（0017 收敛，0925 拍板删「开学季」）+ ''（未分类）
 *   校验，越表 422 VALIDATION_FAILED；
 * - patch 两态：不传=不改、传 ''=显式改未分类；
 * - 写入侧 tags 与导入侧同口径（0925 拍板二）：create/patch 整体落库前过 freeTagsOf，
 *   剔受众词与一切词表词，只洗 tags 不动 category 校验（422 面语义不变）；
 * - 导入（.atskill / SKILL.md / .mdc 共用同一归一口径）：词表外值落 ''、不报错、
 *   且**不再折进 tags**（旧行为已作废）；tags 按 0016 口径（0925 拍板收紧）剔受众词与
 *   一切词表词，其余原序保留；
 * - 导出（.atskill 与 SKILL.md frontmatter）取真实列值，导出→再导入 category 无损。
 * 注意：不给 GET /skills 加 category= 查询参数（用户裁定，筛选在前端本地做），
 * 本文件同时钉一条「传了也不当筛选」的既有形状，防后续棒顺手加。
 */

const CONTENT = {
  blocks: [{ id: 'b1', kind: 'prompt', title: '开场', prompt: '内容' }],
  entryBlockId: 'b1',
};

async function createSkill(ui: Sender, overrides: Record<string, unknown> = {}) {
  const res = await ui.post(`${API}/skills`, {
    name: `分类技能-${Math.random().toString(36).slice(2, 8)}`,
    type: 'flow',
    description: '',
    tags: [],
    content: CONTENT,
    mcp_dependencies: [],
    ...overrides,
  });
  if (res.status !== 201) throw new Error(`建技能失败：${res.status} ${res.text}`);
  return res.body;
}

describe('skills.category 读写面与导入导出（C-3）', () => {
  let t: TestApp;
  let ui: Sender;

  beforeAll(async () => {
    t = await createTestApp();
    ui = uiSender(t);
  });

  afterAll(async () => {
    await t.close();
  });

  // ---------------------------------------------------------------- A. DTO 与读写面

  it('create：合法 category 落库并回读；缺省=未分类 ""；list 与 detail 出参含 category', async () => {
    const skill = await createSkill(ui, { category: '质量保障', tags: ['review', 'quality'] });
    expect(skill.category).toBe('质量保障');
    // 真库回读：列值确实落了（不是 dto 拼出来的）
    const row = await t.prisma.skill.findUnique({ where: { id: skill.id } });
    expect(row?.category).toBe('质量保障');
    const detail = await ui.get(`${API}/skills/${skill.id}`);
    expect(detail.body.category).toBe('质量保障');
    const list = await ui.get(`${API}/skills?keyword=${encodeURIComponent(skill.name)}`);
    expect(list.body.items[0]).toMatchObject({ id: skill.id, category: '质量保障' });
    // 不传 category 的旧客户端：默认 ''（未分类），不报错
    const plain = await createSkill(ui);
    expect(plain.category).toBe('');
  });

  it('create/patch 越表值（含旧类型枚举 workflow/flow）→ 422 VALIDATION_FAILED，错误体对齐现有风格', async () => {
    const bad = await ui.post(`${API}/skills`, {
      name: '越表技能',
      type: 'flow',
      category: 'workflow',
      tags: [],
      content: CONTENT,
    });
    expect(bad.status).toBe(422);
    expect(bad.body.error.code).toBe('VALIDATION_FAILED');
    expect(JSON.stringify(bad.body)).toContain('category');
    const skill = await createSkill(ui, { category: '开发编程' });
    const badPatch = await ui.patch(`${API}/skills/${skill.id}`, { category: '随便写的分类' });
    expect(badPatch.status).toBe(422);
    expect(badPatch.body.error.code).toBe('VALIDATION_FAILED');
    // 被拒的 patch 不改列值
    expect((await ui.get(`${API}/skills/${skill.id}`)).body.category).toBe('开发编程');
  });

  // 0925 拍板（第四片）：「开学季」已从词表删除，从「词表词」降为「越表值」——
  // create/patch 传它 → 422（与其余越表值同一路径语义）。
  it('create/patch 传已作废的「开学季」→ 越表 422（0925 拍板：12 → 11 后它是越表值）', async () => {
    const bad = await ui.post(`${API}/skills`, {
      name: '已作废分类技能',
      type: 'flow',
      category: '开学季',
      tags: [],
      content: CONTENT,
    });
    expect(bad.status).toBe(422);
    expect(bad.body.error.code).toBe('VALIDATION_FAILED');
    const skill = await createSkill(ui, { category: '教育学习' });
    const badPatch = await ui.patch(`${API}/skills/${skill.id}`, { category: '开学季' });
    expect(badPatch.status).toBe(422);
    expect(badPatch.body.error.code).toBe('VALIDATION_FAILED');
    expect((await ui.get(`${API}/skills/${skill.id}`)).body.category).toBe('教育学习');
  });

  it('patch 两态：不传 category=不改；传 ""=显式改未分类；传词表值=改分类', async () => {
    const skill = await createSkill(ui, { category: '教育学习' });
    const untouched = await ui.patch(`${API}/skills/${skill.id}`, { description: '只改描述' });
    expect(untouched.body.category).toBe('教育学习');
    const toNone = await ui.patch(`${API}/skills/${skill.id}`, { category: '' });
    expect(toNone.body.category).toBe('');
    const back = await ui.patch(`${API}/skills/${skill.id}`, { category: 'Office办公' });
    expect(back.body.category).toBe('Office办公');
  });

  it('写入侧洗 tags（0925 拍板二）：create/patch 剔词表词与受众词，真自由标签原序保留', async () => {
    const skill = await createSkill(ui, {
      category: '推荐',
      // 剔除集合 = 受众词 ∪ 现行 11 词 ∪ 已作废历史词表词「开学季」（RETIRED_CATEGORY_TERMS）；
      // 「开学季」用例保留——它被删出词表后若从 tags 洗漏，卡片会把它重新长成「伪分类」标签。
      tags: ['推荐', '教育学习', '开学季', '官方', '我的自由标签'],
    });
    expect(skill.category).toBe('推荐');
    // 旧口径「写入侧不删词表词」已作废：被 category 取走的 推荐、词表内的 教育学习、
    // 已作废的 开学季、受众词 官方 全部剔除，只剩真自由标签。
    expect(skill.tags).toEqual(['我的自由标签']);
    const row = await t.prisma.skill.findUnique({ where: { id: skill.id } });
    expect(JSON.parse(row!.tags)).toEqual(['我的自由标签']);
    // patch 整体覆盖前同样洗（前后端零改动：UI 原样提交用户输入，服务端兜底）。
    const patched = await ui.patch(`${API}/skills/${skill.id}`, {
      tags: ['社区', '质量保障', '新自由标签', '我的自由标签'],
    });
    expect(patched.body.tags).toEqual(['新自由标签', '我的自由标签']);
    // 只洗 tags 不动 category：越表 category 的 422 面语义不变（见上方用例），
    // 合法 category 在洗过的写入面上照常两态。
    const recategorize = await ui.patch(`${API}/skills/${skill.id}`, { category: '数据分析' });
    expect(recategorize.body.category).toBe('数据分析');
    expect(recategorize.body.tags).toEqual(['新自由标签', '我的自由标签']);
  });

  it('复制路径（技能库复制=GET detail 后 POST create）：category 在读写面上无损带走', async () => {
    const source = await createSkill(ui, { category: '数据分析', tags: ['源标签'] });
    // apps/web copySkill 即此形状：拉全量后按字段 POST。C-5 棒在副本入参里加
    // category: full.category 即可，api 侧这条先钉死。
    const full = (await ui.get(`${API}/skills/${source.id}`)).body;
    const copy = await ui.post(`${API}/skills`, {
      name: `${full.name} 副本`,
      type: full.type,
      description: full.description,
      category: full.category,
      tags: [...full.tags],
      content: full.content,
    });
    expect(copy.status).toBe(201);
    expect(copy.body.id).not.toBe(source.id);
    expect(copy.body.category).toBe('数据分析');
  });

  it('GET /skills 不接受 category 查询参数（筛选在前端本地做，用户裁定；后端不顺手加接口面）', async () => {
    const res = await ui.get(`${API}/skills?category=数据分析`);
    // 未知查询键被 skillListQuerySchema（strip 形状）忽略、返回 200 全量——钉住「不生效」现状。
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.items)).toBe(true);
  });

  // ---------------------------------------------------------------- B. SKILL.md / .mdc / .atskill 导入导出

  it('导入路径洗 tags：受众词与一切词表词都不留（0016 口径），自由标签原序保留', async () => {
    const markdown = [
      '---',
      'name: 收口导入技能',
      'description: 分类直落列',
      'version: 1.0.0',
      'category: 质量保障',
      'tags: [官方, 质量保障, review, 开发编程, quality]',
      '---',
      '',
      '### 开场',
      '',
      '<!-- atb:prompt -->',
      '',
      '正文',
    ].join('\n');
    const res = await ui.post(`${API}/skills/import-markdown`, { filename: 'SKILL.md', content: markdown });
    expect(res.status).toBe(201);
    expect(res.body.category).toBe('质量保障');
    // 0925 拍板新口径：受众词 官方、被 category 取走的 质量保障、以及词表内的第二个分类词
    // 开发编程 全部剔除，只有真自由标签原序留下（tags 出现任何词表词即 fail）。
    expect(res.body.tags).toEqual(['review', 'quality']);
  });

  it('旧包兼容：category 写成类型枚举值 workflow → 归未分类 ""、不报错、且不再折进 tags', async () => {
    const legacy = [
      '---',
      'name: 旧导出包技能',
      'description: 历史包把类型枚举当分类',
      'version: 0.2.0',
      'category: workflow',
      'tags: [示例]',
      '---',
      '',
      '### 开场',
      '',
      '<!-- atb:prompt -->',
      '',
      '正文',
    ].join('\n');
    const res = await ui.post(`${API}/skills/import-markdown`, { filename: 'legacy.md', content: legacy });
    expect(res.status).toBe(201);
    expect(res.body.category).toBe('');
    // 「category 折进标签」的旧路径已断：workflow 既不进 category 也不进 tags
    expect(res.body.tags).toEqual(['示例']);
    expect(res.body.tags).not.toContain('workflow');
  });

  it('导入归一：category=「开学季」（0925 拍板删词后是越表值）→ 落未分类 ""、不报错；tags 里的它也被作废词集合洗掉', async () => {
    const markdown = [
      '---',
      'name: 已作废分类导入',
      'description: 词表缩短后按越表归一',
      'version: 1.0.0',
      'category: 开学季',
      'tags: [开学季, 教育学习, 自由一词]',
      '---',
      '',
      '### 开场',
      '',
      '<!-- atb:prompt -->',
      '',
      '正文',
    ].join('\n');
    const res = await ui.post(`${API}/skills/import-markdown`, { filename: 'retired.md', content: markdown });
    expect(res.status).toBe(201);
    // 非 zod 入口的归一口径：越表落 ''（与 workflow 旧包同路径语义），不报错。
    expect(res.body.category).toBe('');
    // tags 剔除集合含已作废历史词表词：开学季（RETIRED）与词表词 教育学习 都不留。
    expect(res.body.tags).toEqual(['自由一词']);
  });

  it('.mdc（Cursor 格式）导入共用同一 category 分支：词表值直落列', async () => {
    const mdc = [
      '---',
      'description: mdc 也走同一解析',
      'alwaysApply: true',
      'category: 实用工具',
      'tags: [cursor]',
      '---',
      '',
      '### 检查',
      '',
      '<!-- atb:constraint -->',
      '',
      '规则：祈使句',
    ].join('\n');
    const res = await ui.post(`${API}/skills/import-markdown`, { filename: 'rule.mdc', content: mdc });
    expect(res.status).toBe(201);
    expect(res.body.category).toBe('实用工具');
    expect(res.body.tags).toEqual(['cursor']);
  });

  it('本棒闭环：SKILL.md 导出→再导入（同 ID 覆盖）category 无损', async () => {
    const skill = await createSkill(ui, {
      name: '闭环往返',
      category: 'Office办公',
      tags: ['周报', 'ppt'],
    });
    const exported = await ui.send(`${API}/skills/${skill.id}/export-markdown`);
    expect(exported.status).toBe(200);
    // 导出 frontmatter 取真实列值（不再是硬编码 ''，也不许是类型枚举）
    expect(exported.text).toContain('category: Office办公');
    expect(exported.text).toContain('tags: [周报, ppt]');
    const reimported = await ui.send(`${API}/skills/import-markdown?on_conflict=overwrite`, {
      method: 'POST',
      body: { filename: '闭环往返.md', content: exported.text },
    });
    expect(reimported.status).toBe(201);
    expect(reimported.body.id).toBe(skill.id);
    expect(reimported.body.category).toBe('Office办公');
    expect(reimported.body.tags).toEqual(['周报', 'ppt']);
  });

  it('.atskill 导出带 category，导入归一后同列往返（词表外值同样归未分类、不报错）', async () => {
    const skill = await createSkill(ui, { name: 'atskill-往返', category: '方案写作', tags: ['标书'] });
    const exported = await ui.send(`${API}/skills/${skill.id}/export`);
    const payload = JSON.parse(exported.text);
    expect(payload.category).toBe('方案写作');
    const form = new FormData();
    form.append('file', new Blob([JSON.stringify(payload)], { type: 'application/json' }), 'x.atskill');
    const reimported = await ui.send(`${API}/skills/import?on_conflict=overwrite`, {
      method: 'POST',
      raw: form,
    });
    expect(reimported.status).toBe(201);
    expect(reimported.body.category).toBe('方案写作');
    expect(reimported.body.tags).toEqual(['标书']);
    // 旧包（无 category 字段 / 越表 category + 受众词与词表词混进 tags）归一：
    // 0016 口径下即使 category 落 ''（未分类），词表词 数据分析 也照样从 tags 剔掉
    // （旧口径「未分类不剔任何分类词」已随 0925 拍板作废）。
    const legacyForm = new FormData();
    legacyForm.append(
      'file',
      new Blob(
        [
          JSON.stringify({
            name: '旧包',
            type: 'flow',
            category: 'flow',
            tags: ['社区', '杂项', '数据分析'],
          }),
        ],
        { type: 'application/json' },
      ),
      'legacy.atskill',
    );
    const legacy = await ui.send(`${API}/skills/import`, { method: 'POST', raw: legacyForm });
    expect(legacy.status).toBe(201);
    expect(legacy.body.category).toBe('');
    expect(legacy.body.tags).toEqual(['杂项']);
  });
});
