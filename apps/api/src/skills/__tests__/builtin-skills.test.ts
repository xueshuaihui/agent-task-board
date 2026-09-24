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
  RETIRED_CATEGORY_TERMS,
  SKILL_CATEGORIES,
  SKILL_CATEGORY_TREE,
  STAGE_CATEGORY_TERMS,
  categoryFromTags,
  freeTagsOf,
  isSkillCategory,
} from '../skill-categories';
import { skillContentSchema } from '../skills.dto';

/** 阶段词豁免集（双角色：既是叶子又是合法标签；0925 树化拍板，见 skill-categories.ts）。 */
const STAGE_SET: ReadonlySet<string> = new Set<string>(STAGE_CATEGORY_TERMS);

/**
 * tags 残留判定（**0925 树化后的不变量新口径**）：
 * tags ∩ (叶子 − 六个阶段词) = ∅——六个产研阶段词是双角色豁免词（既是「编码开发」二级
 * 叶子又合法留在 coding 内置 tags 里，用户拍板的有意特例），其余叶子词与作废词都不许出现。
 */
function isPurgedCategoryTerm(tag: string): boolean {
  return (isSkillCategory(tag) && !STAGE_SET.has(tag)) || (RETIRED_CATEGORY_TERMS as readonly string[]).includes(tag);
}

/**
 * v0.0.4 #41：千问工作台技能批量迁移的内置种子守护（映射表 §9 口径）
 * + 0925 编码技能收录（docs/0925/coding-skills-catalog.json，31 条外部编码技能）。
 *
 * 锁六件事：
 * ① 124 条种子齐全（93 千问 + 31 coding）、id 唯一且与 builtin-skills/*.md 清洗终稿同步
 *    （改了 md 不重跑 gen-builtin-seeds.mjs 会红）；分类收口（C-2 + 0925 拍板收紧 + 0925
 *    树化）后同一条还锁 seed 侧的 category/tags 口径：category ∈ 16 叶子词表（0018 收敛，
 *    两级树：删「质量保障」、增六个产研阶段叶子）、tags 里既无作废受众词、也不含
 *    **叶子减阶段词**与已作废历史词表词「开学季」「质量保障」
 *    （0016 口径 + 树化阶段词豁免：标签是标签、分类是分类，93 条千问洗后 tags 为空数组、
 *    31 条 coding 原样带产研阶段标签，都是预期终态）；
 * ② markdown→blocks 解析/兜底双路径都产出可通过 skillContentSchema 的合法内容，
 *    兜底块全文无损；
 * ③ 17 条「依赖千问后端」档：降级不收 quark-drive，其余 16 条带降级说明行、
 *    不残留平台专属工具关键词；
 * ④ ensureDefaultSkills 幂等：重复执行不增行；且预置真的把 category 写进库、tags 不再回灌
 *    受众词（否则 0015 迁移洗的数会被启动 upsert 全部洗回去）；
 * ⑤ 全量 125 条（含 §9.2 规范样例 code-review）的 category 守护 + 分类分布快照 +
 *    tags 快照（千问源为空 / coding 源逐条等于目录给定的阶段标签）；
 * ⑥ 分片 ⇔ 两份目录（千问 catalog / 0925 coding 目录）⇔ skill-categories.ts helper ⇔
 *    生成器字面量 ⇔ 0018 CHECK 同口径（树展平=16 叶子、三方词表字面逐字一致），杜绝
 *    「生成器自己算一套、运行时再猜一套、迁移 CHECK 又一套」。
 */

const MD_DIR = path.resolve(__dirname, '../builtin-skills');
const API_ROOT = path.resolve(__dirname, '../../..');
const REPO_ROOT = path.resolve(API_ROOT, '../..');
const CATALOG_PATH = path.join(REPO_ROOT, 'docs/v0.0.4/skills-data/qwen-skills-catalog.json');
const CODING_CATALOG_PATH = path.join(REPO_ROOT, 'docs/0925/coding-skills-catalog.json');
const GENERATOR_PATH = path.join(API_ROOT, 'scripts/gen-builtin-seeds.mjs');
/** 0018 迁移（现行 category CHECK 真值源）：⑥ 的字面三方比对之一。 */
const MIGRATION_0018_PATH = path.join(API_ROOT, 'prisma/migrations/0018_skill_category_tree/migration.sql');
/** 内置条数（#41 千问迁移 93 + 0925 编码技能 31）与含 code-review 的全量条数（改了收编范围要一并改这里）。 */
const BUILTIN_COUNT = 124;
const TOTAL_COUNT = 125;
/** 抽取生成器里的字面量数组/对象：与运行时常量比对，防止两处各写一套词表。 */
function literalFromGenerator(decl: string): unknown {
  const src = readFileSync(GENERATOR_PATH, 'utf8');
  const hit = src.match(new RegExp(`const ${decl} = (\\[[^\\]]*\\]|\\{[^}]*\\});`));
  if (!hit) throw new Error(`生成器里找不到 const ${decl}`);
  // 生成器里是多行字面量且带尾逗号：先换引号、再去尾逗号，才能喂给 JSON.parse。
  return JSON.parse(hit[1].replace(/'/g, '"').replace(/,(\s*[\]}])/g, '$1'));
}
/** 生成器 CATEGORY_FIXES 补正表：缺分类词型 + 0925 拍板一的「0015 首词盲取错值」纠偏型
 * （+ 树化 Q3 拍板三条「方案写作→需求与规划」，补正值 ≠ 首词计算值，合法有效条目）。 */
function categoryFixes(): Record<string, string> {
  return literalFromGenerator('CATEGORY_FIXES') as Record<string, string>;
}

/** 0925 编码技能目录（第二源）：category/tags 显式给定，source 溯源字段不进分片。 */
interface CodingCatalogEntry {
  slug: string;
  nameCn: string;
  description: string;
  category: string;
  tags: string[];
  source: { repo: string; path: string; fetched: boolean; truncated: boolean; renamedFrom?: string };
}
const CODING_CATALOG = JSON.parse(readFileSync(CODING_CATALOG_PATH, 'utf8')) as CodingCatalogEntry[];
const CODING_SLUGS = new Set(CODING_CATALOG.map((item) => item.slug));

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

  it('① 124 条种子（93 千问 + 31 coding）齐全、id 唯一、字段合法，且与 builtin-skills/*.md 终稿同步', () => {
    expect(BUILTIN_SKILL_SEEDS.length).toBe(BUILTIN_COUNT);
    const ids = BUILTIN_SKILL_SEEDS.map((seed) => seed.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(new Set(BUILTIN_SKILL_SEEDS.map((seed) => seed.name)).size).toBe(BUILTIN_COUNT);
    for (const seed of BUILTIN_SKILL_SEEDS) {
      expect(seed.id).toMatch(/^skl_builtin_[a-z0-9._-]+$/);
      expect(seed.description.length).toBeGreaterThan(0);
      // 分类收口（C-2 + 0925 收紧 + 树化）：不再断言 tags 数量——千问源 catalog 的 tags
      // 主要是「受众词 + 分类词」，新口径下全部剔掉；coding 源显式带产研阶段标签（⑤ 逐条
      // 对照目录，阶段词是双角色豁免词、有意保留）。这里锁两条硬口径：tags 无受众词、无任何
      // 非阶段叶子词与已作废历史词表词「开学季」「质量保障」（残留它们即以普通标签身份重新
      // 长成「伪分类」）。
      expect(isSkillCategory(seed.category), `${seed.id} category 不在 16 叶子词表：${seed.category}`).toBe(true);
      for (const tag of seed.tags) {
        expect(AUDIENCE_TAGS as readonly string[], `${seed.id} 残留受众词 ${tag}`).not.toContain(tag);
        expect(isPurgedCategoryTerm(tag), `${seed.id} 自由标签里残留词表/作废词 ${tag}`).toBe(false);
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

  it('④ 幂等：重复 ensure 不增行，列表 total=125（含 code-review），且分类真的落库', async () => {
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
        expect(isPurgedCategoryTerm(tag), `${row.id} 库内 tags 残留词表/作废词 ${tag}`).toBe(false);
      }
    }
    // PRD §9.2 规范样例：单值分类 + 自由标签两字段各归各位（0925 树化：作废旧值「质量保障」
    // 的唯一语义续位是「编码开发/质量与安全」叶子，seed/0019 两侧同值收敛）。
    const codeReview = rows.find((row) => row.id === 'skl_builtin_code-review');
    expect(codeReview?.category).toBe('质量与安全');
    expect(JSON.parse(codeReview?.tags ?? '[]')).toEqual(['review', 'quality']);
  });

  it('⑤ 全量 125 条内置种子守护：category 全部 ∈ 词表（内置不允许未分类）、id 唯一', () => {
    expect(DEFAULT_SKILL_SEEDS.length).toBe(TOTAL_COUNT);
    const ids = DEFAULT_SKILL_SEEDS.map((seed) => seed.id);
    expect(new Set(ids).size).toBe(TOTAL_COUNT);
    expect(DEFAULT_SKILL_SEEDS[0]!.id).toBe('skl_builtin_code-review');
    for (const seed of DEFAULT_SKILL_SEEDS) {
      expect(isSkillCategory(seed.category), `${seed.id} category 非法：${JSON.stringify(seed.category)}`).toBe(true);
    }
    // 分布锁（0925 树化终值，草案 §2 映射表 + Q1 保留开发编程/Q2 三条改判质量与安全/
    // Q3 千问三条进需求与规划拍板后口径）：0015 回填 + seed 收口 + CATEGORY_FIXES +
    // 编码技能收录 + 树化 35 行归位（0019 同值）后库内应有的 16 叶子分布——
    // 多一条/少一条都会红，防误改词表树、补正表与 coding 目录。六个阶段桶合计 35+code-review
    // 样例=编码域 40 条（需求与规划 8 = coding5+千问3；质量与安全 10 = coding6+Q2 三条+样例）；
    // 「质量保障」「开学季」都不在桶里（内置零条是预期终态，16 键恰好覆盖现行 16 叶子）。
    const dist = DEFAULT_SKILL_SEEDS.reduce<Record<string, number>>((acc, seed) => {
      acc[seed.category] = (acc[seed.category] ?? 0) + 1;
      return acc;
    }, {});
    expect(dist).toEqual({
      需求与规划: 8,
      开发与实现: 4,
      质量与安全: 10,
      代码清理: 6,
      运维与协作: 5,
      测试自动化: 2,
      开发编程: 5,
      教育学习: 23,
      内容创作: 12,
      方案写作: 9,
      投资理财: 13,
      Office办公: 9,
      实用工具: 8,
      数据分析: 6,
      资讯研究: 4,
      推荐: 1,
    });
    expect(Object.keys(dist)).toHaveLength(16);
    // tags 快照（口径 = 0925 拍板收紧后的 0016 洗数段 + 作废词 + 0925 编码技能收录双源 +
    // 树化阶段词豁免）——不再是一句「全为空」，按来源三分收紧：
    // ① 93 条千问迁移内置洗后 tags 必须全为空数组（catalog 的 tags 本就是「受众词 +
    //    分类词」，谁回流谁红）；
    // ② 31 条 coding 内置必须逐条等于 docs/0925/coding-skills-catalog.json 给定的产研
    //    阶段标签（原样、含顺序；这六个阶段词是双角色豁免词——既是叶子又合法留在 tags，
    //    0925 树化拍板「继续不洗」，逐条等值锁不动）；
    // ③ 唯一非两源的手写 §9.2 规范样例 code-review 保持 review/quality 两个真自由标签。
    expect(CODING_CATALOG).toHaveLength(31);
    const qwenSlugs = new Set(
      (JSON.parse(readFileSync(CATALOG_PATH, 'utf8')) as Array<{ slug: string }>).map((item) => item.slug),
    );
    for (const seed of DEFAULT_SKILL_SEEDS) {
      if (seed.name === 'code-review') continue;
      if (CODING_SLUGS.has(seed.name)) {
        const entry = CODING_CATALOG.find((item) => item.slug === seed.name)!;
        expect(seed.tags, `${seed.id} coding tags 与目录不一致`).toEqual(entry.tags);
        expect(seed.tags.length, `${seed.id} coding 必须带产研阶段标签`).toBeGreaterThan(0);
      } else {
        expect(qwenSlugs.has(seed.name), `${seed.id} 不属于任何一源`).toBe(true);
        expect(seed.tags, `${seed.id} 千问迁移内置 tags 应为空数组`).toEqual([]);
      }
    }
    const tagDist: Record<string, number> = {};
    for (const seed of DEFAULT_SKILL_SEEDS) {
      for (const tag of seed.tags) tagDist[tag] = (tagDist[tag] ?? 0) + 1;
    }
    // 2（code-review）+ 32（31 条 coding 共 32 个阶段词：codexqa-defect-analyzer 双阶段）= 34。
    expect(Object.values(tagDist).reduce((a, b) => a + b, 0)).toBe(34);
    expect(DEFAULT_SKILL_SEEDS.filter((seed) => seed.tags.length > 0).length).toBe(32);
    expect(tagDist).toEqual({
      review: 1,
      quality: 1,
      需求与规划: 5,
      开发与实现: 6,
      质量与安全: 6,
      代码清理: 6,
      运维与协作: 6,
      测试自动化: 3,
    });
    // 定点防线（0925 拍板一+四的合体靶子，树化 Q1 后仍有效）：code-mentor 的 catalog tags 是
    // [开学季, 开发编程]——「开学季」不在词表、首词规则直接算出「开发编程」；若词表哪天飘回
    // 12 项（含开学季），本条立刻红——它是现行 16 叶子收敛最锋利的哨兵。Q1 拍板「开发编程」
    // 保留为「编码开发」下过渡二级（千问 5 条存量零迁移），本条 category 不动。
    // 拍板收紧口径不变：「开发编程」（非阶段叶子）与「开学季」都不得留在 tags 里（曾在真机
    // 卡片上与分类徽标同字重现，造成「两套分类标准」观感）。谁把 freeTagsOf 退回旧口径，本条即红。
    const codeMentor = DEFAULT_SKILL_SEEDS.find((seed) => seed.name === 'code-mentor');
    expect(codeMentor?.category).toBe('开发编程');
    expect(codeMentor?.tags).toEqual([]);
    // 定点防线（0925 收录的两处改名 + 一处双阶段）：名字必须与正文相符、溯源记在目录
    // source.renamedFrom；deprecation-and-migration 是 database 改名收编的正身，树化后
    // category 随 coding 目录改判「开发与实现」（tags 仍是 [开发与实现]）。
    const depRow = DEFAULT_SKILL_SEEDS.find((seed) => seed.name === 'deprecation-and-migration');
    expect(depRow?.category).toBe('开发与实现');
    expect(depRow?.tags).toEqual(['开发与实现']);
    const defect = DEFAULT_SKILL_SEEDS.find((seed) => seed.name === 'codexqa-defect-analyzer');
    expect(defect?.tags).toEqual(['开发与实现', '测试自动化']);
    // 按 Q2 拍板：defect-analyzer 内容改判「质量与安全」，与 tags 首词解耦。
    expect(defect?.category).toBe('质量与安全');
    // 逐条守护：seed 的 tags 里出现任何**非阶段**叶子词或已作废历史词表词（开学季/质量保障）
    // 即 fail（0016 口径 + 0017/0018 作废词的服务端等价物 + 树化阶段词豁免，
    // 防生成器/helper 两侧飘回旧口径）。
    for (const seed of DEFAULT_SKILL_SEEDS) {
      for (const tag of seed.tags) {
        expect(isPurgedCategoryTerm(tag), `${seed.id} tags 残留词表/作废词 ${tag}`).toBe(false);
      }
    }
  });

  it('⑥ 分片 ⇔ 两份目录（千问 catalog / 0925 coding 目录）⇔ skill-categories.ts ⇔ 生成器字面量 ⇔ 0018 CHECK 同口径（生成器/迁移不得自造一套）', () => {
    // 词表字面量必须逐字一致（生成器是 .mjs，import 不了 TS 常量）：现行 16 叶子、
    // 阶段词豁免集、受众词、已作废历史词表词（开学季 + 树化作废的质量保障）——
    // 少比一份都会让两侧漂移；再加两层树口径：SKILL_CATEGORY_TREE 展平 = 16 叶子、
    // 0018 迁移 CHECK 的 IN 列表 = '' + 16 叶子（顺序无关的字面集合一致）。
    expect(literalFromGenerator('SKILL_CATEGORIES')).toEqual([...SKILL_CATEGORIES]);
    expect(literalFromGenerator('STAGE_CATEGORY_TERMS')).toEqual([...STAGE_CATEGORY_TERMS]);
    expect(literalFromGenerator('AUDIENCE_TAGS')).toEqual([...AUDIENCE_TAGS]);
    expect(literalFromGenerator('RETIRED_CATEGORY_TERMS')).toEqual([...RETIRED_CATEGORY_TERMS]);
    expect(SKILL_CATEGORIES).toHaveLength(16);
    expect(SKILL_CATEGORIES).not.toContain('开学季');
    expect(SKILL_CATEGORIES).not.toContain('质量保障');
    expect(RETIRED_CATEGORY_TERMS).toEqual(['开学季', '质量保障']);
    // 树 ⇔ 叶子：一级 7 个、纯分组一级的 children 与「一级即叶子」的展平结果恰好是 16 叶子，
    // 且全集（一级 ∪ 二级）字面无重复（一级词与二级词不得同词）；阶段词全部在「编码开发」下。
    expect(SKILL_CATEGORY_TREE).toHaveLength(7);
    const treeLeaves = SKILL_CATEGORY_TREE.flatMap((top) =>
      top.children.length > 0 ? top.children : [top.value],
    );
    expect([...treeLeaves].sort()).toEqual([...SKILL_CATEGORIES].sort());
    const allWords = SKILL_CATEGORY_TREE.flatMap((top) => [top.value, ...top.children]);
    expect(new Set(allWords).size).toBe(allWords.length);
    expect(treeLeaves).not.toContain('编码开发');
    expect(treeLeaves).not.toContain('办公实用');
    expect(treeLeaves).not.toContain('研究分析');
    const codingTop = SKILL_CATEGORY_TREE.find((top) => top.value === '编码开发')!;
    for (const stage of STAGE_CATEGORY_TERMS) {
      expect(codingTop.children as readonly string[]).toContain(stage);
    }
    // 0018 CHECK（现行真值源）= '' + 16 叶子：从迁移 SQL 抽 IN 列表比对。
    const migrationSql = readFileSync(MIGRATION_0018_PATH, 'utf8');
    const checkHit = migrationSql.match(/CHECK \(category IN \(([\s\S]*?)\)\)\n/);
    if (!checkHit) throw new Error('0018 迁移里没找到 category CHECK 的 IN 列表');
    const checkValues = (checkHit[1].match(/'([^']*)'/g) ?? []).map((raw) => raw.slice(1, -1));
    expect(checkValues).toContain('');
    expect(checkValues.filter((value) => value !== '').sort()).toEqual([...SKILL_CATEGORIES].sort());
    const catalog = JSON.parse(readFileSync(CATALOG_PATH, 'utf8')) as Array<{
      slug: string;
      tags?: Record<string, string>;
    }>;
    const bySlug = new Map(catalog.map((item) => [item.slug, item]));
    const codingBySlug = new Map(CODING_CATALOG.map((item) => [item.slug, item]));
    // 两源 slug 不得重复（与生成器构建期校验同口径，重复会让 md 归属含糊）。
    for (const slug of codingBySlug.keys()) {
      expect(bySlug.has(slug), `coding 目录与千问 catalog slug 重复：${slug}`).toBe(false);
    }
    const fixes = categoryFixes();
    for (const raw of BUILTIN_SKILLS_RAW) {
      if (codingBySlug.has(raw.slug)) {
        // coding 源：category/tags 目录显式给定（Q2 拍板后 category 与 tags 解耦，机械规则
        // 「叶子=tags 首词」作废——目录直接给定六个阶段叶子之一），分片必须逐字等于目录；
        // tags 必须原样通过 freeTagsOf（阶段词豁免后仍不得混入非阶段叶子/作废/受众词）。
        const entry = codingBySlug.get(raw.slug)!;
        expect(isSkillCategory(entry.category), `${raw.slug} coding 目录分类不在 16 叶子词表`).toBe(true);
        expect(STAGE_CATEGORY_TERMS as readonly string[], `${raw.slug} coding 目录分类必须是六个产研阶段叶子之一`).toContain(entry.category);
        expect(raw.category, `${raw.slug} 分类与 coding 目录不一致`).toBe(entry.category);
        expect(raw.tags, `${raw.slug} 自由标签与 coding 目录不一致`).toEqual(entry.tags);
        expect(freeTagsOf(entry.tags), `${raw.slug} tags 未原样通过 freeTagsOf`).toEqual(entry.tags);
        expect(raw.nameCn).toBe(entry.nameCn);
        expect(raw.description).toBe(entry.description.slice(0, 500));
        continue;
      }
      const item = bySlug.get(raw.slug);
      expect(item, `catalog 缺 ${raw.slug}`).toBeTruthy();
      const original = Object.keys(item!.tags || {}).filter(Boolean);
      const expected = fixes[raw.slug] ?? categoryFromTags(original);
      expect(raw.category, `${raw.slug} 分类与 helper 口径不一致`).toBe(expected);
      if (!isSkillCategory(expected)) throw new Error(`${raw.slug} helper 口径算出词表外分类：${expected}`);
      // 自由标签 = catalog 原始 tags 洗掉受众词与**一切词表词**（含第二个分类词），
      // 其余原序保留——口径与 0016 洗数段一致，见 freeTagsOf 注释（0925 拍板收紧）。
      expect(raw.tags, `${raw.slug} 自由标签与 helper 口径不一致`).toEqual(freeTagsOf(original));
    }
    // 补正表是「上游数据缺陷 / 0015 首词盲取错值」的唯一豁免口：条目必须真的缺词、
    // 或补正确实改变了首词规则的结果（与生成器防呆同逻辑）——上游修好数据后及时清理。
    // 0925 双源后补正表只许收千问源 slug（coding 源 category 显式给定，无需补正）。
    for (const [slug, fixed] of Object.entries(fixes)) {
      expect(isSkillCategory(fixed), `${slug} 补正成了词表外分类`).toBe(true);
      expect(codingBySlug.has(slug), `CATEGORY_FIXES 只许收千问源 slug：${slug}`).toBe(false);
      const computed = categoryFromTags(Object.keys(bySlug.get(slug)?.tags || {}));
      expect(fixed, `${slug} 的补正是 no-op（首词规则已算出 ${JSON.stringify(computed)}），清理 CATEGORY_FIXES`).not.toBe(computed);
    }
    // coding 目录自身完备性：md ⇔ 目录双向一一对应（正向已在 ① 的分片⇔md 锁里覆盖，
    // 这里补反向——目录多余条目即漏收正文）；source 溯源字段留在目录、不进分片。
    const mdSlugs = readdirSync(MD_DIR).filter((f) => f.endsWith('.md')).map((f) => f.slice(0, -3));
    for (const entry of CODING_CATALOG) {
      expect(mdSlugs, `coding 目录多余条目（缺正文 md）：${entry.slug}`).toContain(entry.slug);
      expect(entry.source.fetched, `${entry.slug} source.fetched 必须为 true`).toBe(true);
      expect(entry.source.repo.length).toBeGreaterThan(0);
      expect(entry.source.path.length).toBeGreaterThan(0);
    }
    for (const raw of BUILTIN_SKILLS_RAW) {
      const extra = Object.keys(raw).filter((k) => !['slug', 'nameCn', 'description', 'category', 'tags', 'markdown'].includes(k));
      expect(extra, `${raw.slug} 分片混入目录溯源字段：${extra.join(', ')}`).toEqual([]);
    }
  });
});
