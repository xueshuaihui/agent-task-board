import { existsSync, readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Sender, TestApp } from '../../__tests__/helpers/http-app';
import { createTestApp } from '../../__tests__/helpers/http-app';
import { API, uiSender } from '../../__tests__/helpers/seed';
import { DEFAULT_SKILL_SEEDS, ensureDefaultSkills } from '../default-skills';
import { BUILTIN_SKILLS_RAW, BUILTIN_SKILL_SEEDS, convertBuiltinMarkdown } from '../builtin-skills';
import { skillContentSchema } from '../skills.dto';

/**
 * v0.0.4 #41：千问工作台技能批量迁移的内置种子守护（映射表 §9 口径）。
 *
 * 锁四件事：
 * ① 93 条种子齐全、id 唯一且与 builtin-skills/*.md 清洗终稿同步（改了 md 不重跑
 *    gen-builtin-seeds.mjs 会红）；
 * ② markdown→blocks 解析/兜底双路径都产出可通过 skillContentSchema 的合法内容，
 *    兜底块全文无损；
 * ③ 17 条「依赖千问后端」档：降级不收 quark-drive，其余 16 条带降级说明行、
 *    不残留平台专属工具关键词；
 * ④ ensureDefaultSkills 幂等：重复执行不增行。
 */

const MD_DIR = path.resolve(__dirname, '../builtin-skills');
/** summary.json hits 非空的 17 条降级档（quark-drive 降级后无有效内容，不收）。 */
const DOWNGRADED = [
  'self-finance-select', 'self-finance-sector', 'suozhang-linchao-investment-analysis',
  'image-transoffice', 'social-opinion-collector', 'news-summary', 'proactive-paper-recommendation',
  'excel', 'guizang-ppt-skill', 'academic-search', 'financial-analyst', 'backtesting-frameworks',
  'self-finance-data', 'paper-deep-reading', 'zoey-kaoyan-planning-coach', 'visual-agent',
];
/** 千问平台专属工具/接口关键词：降级档正文不得残留（「夸克眼镜」等产品名词示例除外）。 */
const PLATFORM_TOOL_RE =
  /(quark_scan|quark-drive|夸克扫描|夸克网盘|恒生聚源|聚源|盈米|万相|wanx|qwen3[-_ ]?tts|tts_synthesize|语音合成|语音播报|内置搜索|web_search|实时行情|scripts\/[\w.-]+\.(py|sh|js))/i;
const DOWNGRADE_NOTE = '本技能由千问工作台技能降级迁移，原平台专属能力不可用';

describe('千问迁移内置种子（#41）', () => {
  let t: TestApp;
  let ui: Sender;

  beforeAll(async () => {
    t = await createTestApp();
    ui = uiSender(t);
  });

  afterAll(async () => {
    await t.close();
  });

  it('① 93 条种子齐全、id 唯一、字段合法，且与 builtin-skills/*.md 清洗终稿同步', () => {
    expect(BUILTIN_SKILL_SEEDS.length).toBe(93);
    const ids = BUILTIN_SKILL_SEEDS.map((seed) => seed.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(new Set(BUILTIN_SKILL_SEEDS.map((seed) => seed.name)).size).toBe(93);
    for (const seed of BUILTIN_SKILL_SEEDS) {
      expect(seed.id).toMatch(/^skl_builtin_[a-z0-9._-]+$/);
      expect(seed.description.length).toBeGreaterThan(0);
      expect(seed.tags.length).toBeGreaterThanOrEqual(1);
      expect(seed.mcpDependencies).toEqual([]);
    }
    // 同步守护：分片 ⇔ md 终稿一一对应、逐条等值（改 md 必须重跑生成器）。
    const mdSlugs = readdirSync(MD_DIR).filter((f) => f.endsWith('.md')).map((f) => f.slice(0, -3));
    expect(mdSlugs.sort()).toEqual(BUILTIN_SKILLS_RAW.map((raw) => raw.slug).sort());
    for (const raw of BUILTIN_SKILLS_RAW) {
      expect(raw.markdown).toBe(readFileSync(path.join(MD_DIR, `${raw.slug}.md`), 'utf8'));
    }
    // 平台测试垃圾 codex-lang-test-* 与降级后无内容的 quark-drive 不收。
    expect(ids.some((id) => id.includes('codex-lang-test'))).toBe(false);
    expect(ids).not.toContain('skl_builtin_quark-drive');
  });

  it('② blocks 转换：解析/兜底双路径均产出合法 content，兜底全文无损', () => {
    const modes = BUILTIN_SKILLS_RAW.map((raw) => convertBuiltinMarkdown(raw).mode);
    const flowCount = modes.filter((m) => m === 'flow').length;
    // eslint-disable-next-line no-console
    console.log(`[builtin-skills] markdown→blocks：解析 ${flowCount} / 兜底 ${modes.length - flowCount}`);
    expect(flowCount).toBeGreaterThan(0);
    expect(flowCount).toBeLessThan(modes.length); // 双路径都必须真实被覆盖到
    BUILTIN_SKILL_SEEDS.forEach((seed, index) => {
      expect(seed.type).toBe(modes[index] === 'flow' ? 'flow' : 'prompt');
      const parsed = skillContentSchema.safeParse(seed.content);
      expect(parsed.success, `${seed.id} content 不合 schema`).toBe(true);
      expect(seed.content.blocks.length).toBeGreaterThan(0);
      if (modes[index] === 'prompt') {
        // 兜底：分片拼接后必须无损还原全文（title=技能名）。
        const joined = seed.content.blocks.map((block) => block.prompt ?? '').join('');
        expect(joined).toBe(BUILTIN_SKILLS_RAW[index]!.markdown);
        expect(seed.content.blocks[0]!.title.length).toBeGreaterThan(0);
      }
    });
  });

  it('③ 降级档：16 条收编带说明行且不残留平台工具关键词；quark-drive 不收', () => {
    for (const slug of DOWNGRADED) {
      const raw = BUILTIN_SKILLS_RAW.find((item) => item.slug === slug);
      expect(raw, `降级档缺 ${slug}`).toBeTruthy();
      expect(raw!.markdown.split('\n').slice(0, 3).join('\n')).toContain(DOWNGRADE_NOTE);
      const hit = raw!.markdown.split('\n').find((line) => PLATFORM_TOOL_RE.test(line));
      expect(hit, `${slug} 残留平台工具关键词：${hit}`).toBeUndefined();
    }
    expect(existsSync(path.join(MD_DIR, 'quark-drive.md'))).toBe(false);
  });

  it('④ 幂等：重复 ensure 不增行，列表 total=94（含 code-review）', async () => {
    const first = await ensureDefaultSkills(t.prisma);
    expect(first.created.length).toBe(DEFAULT_SKILL_SEEDS.length);
    expect(first.created.length).toBe(94);
    const second = await ensureDefaultSkills(t.prisma);
    expect(second.created).toEqual([]);
    expect(second.updated.length).toBe(94);
    expect(await t.prisma.skill.count({ where: { sourceType: 'default' } })).toBe(94);
    const list = await ui.get(`${API}/skills?source=default`);
    expect(list.status).toBe(200);
    expect(list.body.total).toBe(94);
    expect(Array.isArray(list.body.items)).toBe(true);
  });
});
