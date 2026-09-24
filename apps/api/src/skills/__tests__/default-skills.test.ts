import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestApp, errorCode, type Sender, type TestApp } from '../../__tests__/helpers/http-app';
import { API, uiSender } from '../../__tests__/helpers/seed';
import { DEFAULT_SKILL_SEEDS, ensureDefaultSkills } from '../default-skills';
import { DEFAULT_SKILL_VERSION } from '../skills.dto';

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
    // §9.6 默认技能无版本历史：预置不建 skill_versions 行。
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

  it('重复预置幂等：无副本、走更新分支、内置内容随包刷新', async () => {
    const second = await ensureDefaultSkills(t.prisma);
    expect(second.created).toEqual([]);
    expect(second.updated).toHaveLength(DEFAULT_SKILL_SEEDS.length);
    const defaults = await ui.get(`${API}/skills?source=default`);
    expect(defaults.body.total).toBe(DEFAULT_SKILL_SEEDS.length);
    expect(defaults.body.items.map((row: { id: string }) => row.id)).toContain(DEFAULT_SKILL_SEEDS[0]!.id);
  });
});
