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

  it('清单只落 PRD §9.2 规范样例这 1 条内置默认技能，不编造多条目', () => {
    expect(DEFAULT_SKILL_SEEDS).toHaveLength(1);
    expect(DEFAULT_SKILL_SEEDS[0]!.id).toBe('skl_builtin_code-review');
  });

  it('首次预置：列表读到 source=default、版本 builtin、只读，且不写版本历史', async () => {
    const result = await ensureDefaultSkills(t.prisma);
    expect(result.created).toEqual([DEFAULT_SKILL_SEEDS[0]!.id]);
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
    expect(second.updated).toEqual([DEFAULT_SKILL_SEEDS[0]!.id]);
    const defaults = await ui.get(`${API}/skills?source=default`);
    expect(defaults.body.total).toBe(1);
    expect(defaults.body.items.map((row: { id: string }) => row.id)).toContain(DEFAULT_SKILL_SEEDS[0]!.id);
  });
});
