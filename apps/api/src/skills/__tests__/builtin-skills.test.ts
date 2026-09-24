import { existsSync, readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Sender, TestApp } from '../../__tests__/helpers/http-app';
import { createTestApp } from '../../__tests__/helpers/http-app';
import { API, uiSender } from '../../__tests__/helpers/seed';
import { DEFAULT_SKILL_SEEDS, ensureDefaultSkills } from '../default-skills';
import { BUILTIN_SKILLS_RAW, BUILTIN_SKILL_SEEDS, convertBuiltinMarkdown } from '../builtin-skills';
import {
  AUDIENCE_TAGS,
  SKILL_CATEGORIES,
  categoryFromTags,
  freeTagsOf,
  isSkillCategory,
} from '../skill-categories';
import { skillContentSchema } from '../skills.dto';

/**
 * v0.0.4 #41：千问工作台技能批量迁移的内置种子守护（映射表 §9 口径）。
 *
 * 锁六件事：
 * ① 93 条种子齐全、id 唯一且与 builtin-skills/*.md 清洗终稿同步（改了 md 不重跑
 *    gen-builtin-seeds.mjs 会红）；分类收口（C-2）后同一条还锁 seed 侧的 category/tags 口径：
 *    category ∈ 12 词表、tags 里既无作废受众词也无任何词表词（自由标签不再混分类语义）；
 * ② markdown→blocks 解析/兜底双路径都产出可通过 skillContentSchema 的合法内容，
 *    兜底块全文无损；
 * ③ 17 条「依赖千问后端」档：降级不收 quark-drive，其余 16 条带降级说明行、
 *    不残留平台专属工具关键词；
 * ④ ensureDefaultSkills 幂等：重复执行不增行；且预置真的把 category 写进库、tags 不再回灌
 *    受众词（否则 0015 迁移洗的数会被启动 upsert 全部洗回去）；
 * ⑤ 全量 94 条（含 §9.2 规范样例 code-review）的 category 守护 + 分类分布快照；
 * ⑥ 分片 ⇔ 千问原始 catalog ⇔ skill-categories.ts helper 三方同口径（含生成器词表与本文件
 *    词表逐字一致），杜绝「生成器自己算一套、运行时再猜一套」。
 */

const MD_DIR = path.resolve(__dirname, '../builtin-skills');
const API_ROOT = path.resolve(__dirname, '../../..');
const REPO_ROOT = path.resolve(API_ROOT, '../..');
const CATALOG_PATH = path.join(REPO_ROOT, 'docs/v0.0.4/skills-data/qwen-skills-catalog.json');
const GENERATOR_PATH = path.join(API_ROOT, 'scripts/gen-builtin-seeds.mjs');
/** #41 批量迁移的条数与含 code-review 的全量条数（改了收编范围要一并改这里）。 */
const BUILTIN_COUNT = 93;
const TOTAL_COUNT = 94;
/** 抽取生成器里的字面量数组/对象：与运行时常量比对，防止两处各写一套词表。 */
function literalFromGenerator(decl: string): unknown {
  const src = readFileSync(GENERATOR_PATH, 'utf8');
  const hit = src.match(new RegExp(`const ${decl} = (\\[[^\\]]*\\]|\\{[^}]*\\});`));
  if (!hit) throw new Error(`生成器里找不到 const ${decl}`);
  // 生成器里是多行字面量且带尾逗号：先换引号、再去尾逗号，才能喂给 JSON.parse。
  return JSON.parse(hit[1].replace(/'/g, '"').replace(/,(\s*[\]}])/g, '$1'));
}
/** 上游 catalog 无分类词、由生成器 CATEGORY_FIXES 显式补正的条目。 */
function categoryFixes(): Record<string, string> {
  return literalFromGenerator('CATEGORY_FIXES') as Record<string, string>;
}

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
    expect(BUILTIN_SKILL_SEEDS.length).toBe(BUILTIN_COUNT);
    const ids = BUILTIN_SKILL_SEEDS.map((seed) => seed.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(new Set(BUILTIN_SKILL_SEEDS.map((seed) => seed.name)).size).toBe(BUILTIN_COUNT);
    for (const seed of BUILTIN_SKILL_SEEDS) {
      expect(seed.id).toMatch(/^skl_builtin_[a-z0-9._-]+$/);
      expect(seed.description.length).toBeGreaterThan(0);
      // 分类收口（C-2）：不再断言 tags 数量——洗完之后 93 条的 tags 全是空数组是预期结果
      // （catalog 里的 tags 本来就是「受众词 + 分类词」，两种都不属于自由标签）。
      expect(isSkillCategory(seed.category), `${seed.id} category 不在 12 词表：${seed.category}`).toBe(true);
      for (const tag of seed.tags) {
        expect(AUDIENCE_TAGS as readonly string[], `${seed.id} 残留受众词 ${tag}`).not.toContain(tag);
        expect(isSkillCategory(tag), `${seed.id} 自由标签里混了分类词 ${tag}`).toBe(false);
      }
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

  it('④ 幂等：重复 ensure 不增行，列表 total=94（含 code-review），且分类真的落库', async () => {
    const first = await ensureDefaultSkills(t.prisma);
    expect(first.created.length).toBe(DEFAULT_SKILL_SEEDS.length);
    expect(first.created.length).toBe(TOTAL_COUNT);
    const second = await ensureDefaultSkills(t.prisma);
    expect(second.created).toEqual([]);
    expect(second.updated.length).toBe(TOTAL_COUNT);
    expect(await t.prisma.skill.count({ where: { sourceType: 'default' } })).toBe(TOTAL_COUNT);
    const list = await ui.get(`${API}/skills?source=default`);
    expect(list.status).toBe(200);
    expect(list.body.total).toBe(TOTAL_COUNT);
    expect(Array.isArray(list.body.items)).toBe(true);
    // 关键回归防线：ensureDefaultSkills 每次启动整份 upsert，seed 一旦不提供 category 就会把
    // 0015 回填的分类刷回 ''、把 seed 里的受众词重新灌进 tags——所以这里直接读库核终值。
    const rows = await t.prisma.skill.findMany({
      where: { sourceType: 'default' },
      select: { id: true, category: true, tags: true },
    });
    expect(rows.length).toBe(TOTAL_COUNT);
    for (const row of rows) {
      expect(isSkillCategory(row.category), `${row.id} 库内 category 未落：${JSON.stringify(row.category)}`).toBe(true);
      const tags = JSON.parse(row.tags) as string[];
      for (const tag of tags) {
        expect(AUDIENCE_TAGS as readonly string[], `${row.id} 库内回灌受众词 ${tag}`).not.toContain(tag);
        expect(isSkillCategory(tag), `${row.id} 库内 tags 混分类词 ${tag}`).toBe(false);
      }
    }
    // PRD §9.2 规范样例：单值分类 + 自由标签两字段各归各位。
    const codeReview = rows.find((row) => row.id === 'skl_builtin_code-review');
    expect(codeReview?.category).toBe('质量保障');
    expect(JSON.parse(codeReview?.tags ?? '[]')).toEqual(['review', 'quality']);
  });

  it('⑤ 全量 94 条内置种子守护：category 全部 ∈ 词表（内置不允许未分类）、id 唯一', () => {
    expect(DEFAULT_SKILL_SEEDS.length).toBe(TOTAL_COUNT);
    const ids = DEFAULT_SKILL_SEEDS.map((seed) => seed.id);
    expect(new Set(ids).size).toBe(TOTAL_COUNT);
    expect(DEFAULT_SKILL_SEEDS[0]!.id).toBe('skl_builtin_code-review');
    for (const seed of DEFAULT_SKILL_SEEDS) {
      expect(isSkillCategory(seed.category), `${seed.id} category 非法：${JSON.stringify(seed.category)}`).toBe(true);
    }
    // 分布锁：0015 回填 + seed 收口后库内应有的分类分布（多一条/少一条都会红，防误改词表映射）。
    const dist = DEFAULT_SKILL_SEEDS.reduce<Record<string, number>>((acc, seed) => {
      acc[seed.category] = (acc[seed.category] ?? 0) + 1;
      return acc;
    }, {});
    expect(dist).toEqual({
      教育学习: 25,
      方案写作: 12,
      内容创作: 12,
      投资理财: 12,
      实用工具: 8,
      推荐: 8,
      Office办公: 5,
      数据分析: 5,
      开发编程: 3,
      开学季: 2,
      资讯研究: 1,
      质量保障: 1,
    });
  });

  it('⑥ 分片 ⇔ 千问原始 catalog ⇔ skill-categories.ts 三方同口径（生成器不得自造一套）', () => {
    // 词表两份字面量必须逐字一致（生成器是 .mjs，import 不了 TS 常量）。
    expect(literalFromGenerator('SKILL_CATEGORIES')).toEqual([...SKILL_CATEGORIES]);
    expect(literalFromGenerator('AUDIENCE_TAGS')).toEqual([...AUDIENCE_TAGS]);
    const catalog = JSON.parse(readFileSync(CATALOG_PATH, 'utf8')) as Array<{
      slug: string;
      tags?: Record<string, string>;
    }>;
    const bySlug = new Map(catalog.map((item) => [item.slug, item]));
    const fixes = categoryFixes();
    for (const raw of BUILTIN_SKILLS_RAW) {
      const item = bySlug.get(raw.slug);
      expect(item, `catalog 缺 ${raw.slug}`).toBeTruthy();
      const original = Object.keys(item!.tags || {}).filter(Boolean);
      const expected = fixes[raw.slug] ?? categoryFromTags(original);
      expect(raw.category, `${raw.slug} 分类与 helper 口径不一致`).toBe(expected);
      // 自由标签 = catalog 原始 tags 洗掉受众词与一切分类词（口径见 freeTagsOf 注释）。
      expect(raw.tags, `${raw.slug} 自由标签与 helper 口径不一致`).toEqual(freeTagsOf(original));
    }
    // 补正表是「上游数据缺陷」的唯一豁免口：条目必须真的缺分类词。
    for (const [slug, fixed] of Object.entries(fixes)) {
      expect(isSkillCategory(fixed), `${slug} 补正成了词表外分类`).toBe(true);
      expect(categoryFromTags(Object.keys(bySlug.get(slug)?.tags || {})), `${slug} 已不需要补正，清理 CATEGORY_FIXES`).toBe('');
    }
  });
});
