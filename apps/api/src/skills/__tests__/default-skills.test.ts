import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestApp, errorCode, type Sender, type TestApp } from '../../__tests__/helpers/http-app';
import { API, uiSender } from '../../__tests__/helpers/seed';
import { DEFAULT_SKILL_SEEDS, ensureDefaultSkills } from '../default-skills';
import { DEFAULT_SKILL_VERSION } from '../skills.dto';
import { SkillsService } from '../skills.service';

/**
 * v0.0.4 #19 ① 默认技能首次启动预置（PRD §20.5-15、验收 49）。
 *
 * 预置只由生产 main.ts 启动路径触发（集成测试应用不自动跑，避免扰动其它用例）；
 * 这里显式对测试库调 ensureDefaultSkills，再经真实 HTTP 读模型核对：
 * source=default / 版本 builtin / 只读（拒改）、内容无损、重复预置幂等。
 */
describe('默认技能预置种子（①）', () => {
  let t: TestApp;
  let ui: Sender;

  beforeAll(async () => {
    t = await createTestApp();
    ui = uiSender(t);
  });

  afterAll(async () => {
    await t.close();
  });

  it('#41 后清单并入千问迁移批次 + 0925 编码技能收录 31 条：code-review 仍在首位，总数 125', () => {
    expect(DEFAULT_SKILL_SEEDS[0]!.id).toBe('skl_builtin_code-review');
    expect(DEFAULT_SKILL_SEEDS).toHaveLength(125);
  });

  it('首次预置：列表读到 source=default、版本 builtin、只读，且不写版本历史', async () => {
    const result = await ensureDefaultSkills(t.prisma);
    expect(result.created).toHaveLength(DEFAULT_SKILL_SEEDS.length);
    expect(result.created).toContain(DEFAULT_SKILL_SEEDS[0]!.id);
    expect(result.updated).toEqual([]);

    const detail = await ui.get(`${API}/skills/${DEFAULT_SKILL_SEEDS[0]!.id}`);
    expect(detail.status).toBe(200);
    expect(detail.body).toMatchObject({
      source: 'default',
      readonly: true,
      current_version: DEFAULT_SKILL_VERSION,
    });
    expect(detail.body.content.blocks.length).toBeGreaterThan(0);
    // §9.6 默认技能无版本历史：预置不建 skill_versions 行（绑定侧的「可解析」口径见最后一条用例）。
    expect(await t.prisma.skillVersion.count({ where: { skillId: DEFAULT_SKILL_SEEDS[0]!.id } })).toBe(0);
    // 分类收口（C-2）：seed 提供的 category 必须真的写进 0015 的新列，tags 保持 §9.2 的纯自由标签。
    // 0925 树化：code-review 样例 category=「质量与安全」（作废旧值「质量保障」的语义续位）。
    const row = await t.prisma.skill.findUniqueOrThrow({
      where: { id: DEFAULT_SKILL_SEEDS[0]!.id },
      select: { category: true, tags: true },
    });
    expect(row.category).toBe('质量与安全');
    expect(JSON.parse(row.tags) as string[]).toEqual(['review', 'quality']);
  });

  it('预置行随只读守卫拒改（§9.1）', async () => {
    const denied = await ui.patch(`${API}/skills/${DEFAULT_SKILL_SEEDS[0]!.id}`, { description: '想改内置' });
    expect(denied.status).toBe(403);
    expect(errorCode(denied)).toBe('SKILL_READONLY');
    const deniedDelete = await ui.del(`${API}/skills/${DEFAULT_SKILL_SEEDS[0]!.id}`);
    expect(deniedDelete.status).toBe(403);
    expect(errorCode(deniedDelete)).toBe('SKILL_READONLY');
  });

  it('重复预置幂等：无副本、内容未变时一个字节都不写（updated_at 不随启动刷新）', async () => {
    const seedId = DEFAULT_SKILL_SEEDS[0]!.id;
    // 把 updated_at 钉到一个明确的历史时刻：启动路径一旦无条件刷新，这里就会被改成本次启动时间。
    const past = '2020-01-01 00:00:00';
    await t.prisma.skill.update({ where: { id: seedId }, data: { updatedAt: past } });

    const second = await ensureDefaultSkills(t.prisma);
    expect(second.created).toEqual([]);
    // 内容与种子逐字段一致 ⇒ 更新分支连走都不走（这就是「技能更新时间不对」的修复点）。
    expect(second.updated).toEqual([]);

    const row = await t.prisma.skill.findUniqueOrThrow({
      where: { id: seedId },
      select: { updatedAt: true },
    });
    expect(row.updatedAt).toBe(past);

    const defaults = await ui.get(`${API}/skills?source=default`);
    expect(defaults.body.total).toBe(DEFAULT_SKILL_SEEDS.length);
    expect(defaults.body.items.map((item: { id: string }) => item.id)).toContain(seedId);
  });

  it('内置内容随包变化时才刷新，并把 updated_at 推进到这一次真实变更', async () => {
    const seed = DEFAULT_SKILL_SEEDS[0]!;
    const stale = '2020-01-01 00:00:00';
    await t.prisma.skill.update({
      where: { id: seed.id },
      data: { description: '被旧版本种子写坏的描述', updatedAt: stale },
    });

    const third = await ensureDefaultSkills(t.prisma);
    expect(third.created).toEqual([]);
    // 只有真的发生过漂移的那一条进 updated；其余 124 条内容没变，不动。
    expect(third.updated).toEqual([seed.id]);

    const row = await t.prisma.skill.findUniqueOrThrow({
      where: { id: seed.id },
      select: { description: true, updatedAt: true },
    });
    expect(row.description).toBe(seed.description);
    expect(row.updatedAt).not.toBe(stale);
  });

  /**
   * 上一个用例锁住的 §9.6（默认技能不建 skill_versions 行）与任务绑定的版本校验相撞：
   * 内置技能的 currentVersion='builtin' 在版本表里查无此行，绑定因此 422
   * `unknown_version`——客户端表现为「编辑任务选技能就 toast 报错」，且首装库里
   * 125 条内置技能全部命中（用户报障的那条链路）。修法是写侧与读侧同口径，
   * 这里两端一起钉住：绑定能写进引用，下发能解析出内容。
   */
  it('内置默认技能可绑定到任务并随任务下发（无版本行不拦绑定）', async () => {
    const seed = DEFAULT_SKILL_SEEDS[0]!;
    const taskRes = await ui.post(`${API}/tasks`, { title: '绑内置技能', type: '需求' });
    expect(taskRes.status).toBe(201);
    const taskId = taskRes.body.id as string;

    const patched = await ui.patch(`${API}/tasks/${taskId}`, { skills: [{ skill_id: seed.id }] });
    expect(patched.status).toBe(200);
    expect(patched.body.skills[0]).toMatchObject({ skill_id: seed.id, version: DEFAULT_SKILL_VERSION });

    // 版本表确实没有这行——下发必须回落 skills 当前内容，而不是给出空载荷。
    expect(await t.prisma.skillVersion.count({ where: { skillId: seed.id } })).toBe(0);
    const skills = t.app.get(SkillsService);
    const payloads = await skills.resolveForTask(JSON.stringify(patched.body.skills));
    expect(payloads).toHaveLength(1);
    expect(payloads[0]).toMatchObject({ skill_id: seed.id, version: DEFAULT_SKILL_VERSION });
    expect(payloads[0]!.content.blocks.length).toBeGreaterThan(0);

    // 显式传不存在的版本仍然拒（放松的只是「current 且无快照」这一态）。
    const bad = await ui.patch(`${API}/tasks/${taskId}`, {
      skills: [{ skill_id: seed.id, version: 'v9.9.9' }],
    });
    expect(bad.status).toBe(422);
    expect(errorCode(bad)).toBe('VALIDATION_FAILED');
  });
});
