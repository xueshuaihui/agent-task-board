#!/usr/bin/env node
/**
 * v0.0.4 #41：从仓库内数据（docs/v0.0.4/skills-data 目录清单 + src/skills/builtin-skills/*.md
 * 清洗后正文）生成内置技能数据分片 builtin-skills.data.<n>.ts。
 *
 * 为什么要 .ts 分片：sidecar 打包是 webpack 单文件 bundle（bundle-sidecar.mjs），
 * nest build 也不拷非 ts 资源——运行态读不到仓库内 .md。正文以 JSON 字符串常量
 * 编进 .ts，才能同时满足 dev ts-node、vitest、打包 sidecar 三种运行态；分片与 md
 * 的同步由 vitest（builtin-skills.test.ts）锁定，改 md 后必须重跑本脚本。
 *
 * 用法：`node scripts/gen-builtin-seeds.mjs`（在 apps/api 下，或 npm run gen:builtin -w @atb/api）
 * 产物入库（CI 全新 checkout 直接可构建，不引用 /tmp）。
 *
 * v0.0.4 分类收口（C-2）：不再折算「官方/社区」受众词（该维度已作废，出处由 source_type
 * 表达），改为产出单值 category + 自由 tags。category 的取词口径与 0015 迁移回填一致
 * （tags 中首个「非受众词且在词表内」的词）；tags 的洗法按 0925 拍板收紧后的 0016 口径——
 * 受众词与词表词都不留，其余原序保留（内置洗后大量条目 tags 为空数组，是预期终态；
 * 0925 树化后追加阶段词豁免，见下方「0925 树化」段），
 * 权威口径见 src/skills/skill-categories.ts。0925 拍板一另起 CATEGORY_FIXES 纠偏段：
 * 12 条内置的 category 因 0015「首词盲取」取到季节/运营占位词（开学季/推荐）或误取的
 * 教育学习，经补正表改判内容词（例外：proactive-paper-recommendation 的「推荐」是真语义）。
 * 同日再拍板（第四片）：词表删「开学季」（0017 迁移收敛 CHECK，12 → 11 项）——code-mentor、
 * deep-research 两条「开学季→X」补正因此变成首词规则即可算出的 no-op，按防呆口径删表；
 * 「开学季」进 RETIRED_CATEGORY_TERMS 作废词集合，freeTagsOf 继续剔它（理由见该常量注释）。
 *
 * 0925 树化（本文件第二改）：词表 11 → 16 **叶子**（两级树，权威源 skill-categories.ts 的
 * SKILL_CATEGORY_TREE，0018 迁移收敛 CHECK）——「质量保障」作废退表（进 RETIRED，14 条 coding
 * 与 code-review 样例逐条改判到阶段叶子），新增六个产研阶段叶子。双角色口径：阶段词既是
 * 「编码开发」二级叶子又是合法自由标签，**freeTagsOf 镜像对六个阶段词豁免不洗**（剔除集合 =
 * 受众词 ∪ (叶子 − 阶段词) ∪ 作废词，不变量 tags ∩ (叶子 − 阶段词) = ∅）。
 *
 * 0925 编码技能收录（本文件第二源）：docs/0925/coding-skills-catalog.json 收 31 条外部
 * 编码技能（GitHub 官方原文正文，builtin-skills/*.md 同名 md），走同一条分片管线：
 * - 千问源（docs/v0.0.4/skills-data 导出，绝对不许改）：category = CATEGORY_FIXES ??
 *   categoryFromTags(tags)，tags 过 freeTagsOf 洗——原逻辑不变（千问 tags 永不含阶段词，
 *   词表含阶段词后首词结果不变）；
 * - coding 源：category 与 tags 都在目录 JSON 里**显式给定**（人工按内容判定，不做首词
 *   盲取；0925 Q2 拍板后「叶子=tags 首词」机械规则作废——codexqa-code-reviewer /
 *   codexqa-defect-analyzer / devops-code-review 三条 category 一律=质量与安全，其 tags
 *   阶段词原样保留，category 与 tags 解耦）；category 必须 ∈ 16 叶子 ∧ ∈ 六个阶段词
 *   （coding 批次只在「编码开发」域），tags 必须原样通过 freeTagsOf（阶段词豁免后仍不得
 *   含非阶段叶子词/作废词/受众词，否则构建期报错）；
 * - source 溯源字段（repo/path/fetched/truncated/renamedFrom）只进目录 JSON 留档，
 *   不进 BuiltinSkillRaw 分片（结构不变）；
 * - 两源 slug 重复、coding 目录缺 md 正文、coding 目录多余条目，都构建期报错；
 *   CATEGORY_FIXES 防呆只作用于千问源。
 */
import { readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * 16 项叶子词表（0925 树化，11 → 16：删「质量保障」、增六个产研阶段叶子）：
 * **必须与 src/skills/skill-categories.ts 的 SKILL_CATEGORIES 逐项一致（含顺序）**，
 * 也与 0018 迁移 category CHECK 的 IN 列表（'' + 16 叶子）同集合。生成器是纯 .mjs
 * （构建期跑，不经过 ts 编译），没法 import TS 常量，所以这里留一份字面量；一致性由
 * src/skills/__tests__/builtin-skills.test.ts 正则抽取本数组与 TS 侧、0018 SQL 三方比对锁住。
 */
const SKILL_CATEGORIES = [
  '教育学习',
  '投资理财',
  '方案写作',
  '内容创作',
  '推荐',
  'Office办公',
  '实用工具',
  '数据分析',
  '开发编程',
  '资讯研究',
  '需求与规划',
  '开发与实现',
  '质量与安全',
  '代码清理',
  '运维与协作',
  '测试自动化',
];
/**
 * 六个产研阶段词（「编码开发」下的二级叶子，双角色特例，与 skill-categories.ts 的
 * STAGE_CATEGORY_TERMS 逐项一致）：既是合法 category 值（coding 源必须取其一），
 * 又是合法自由标签（freeTagsOf 对它们豁免不洗——0925 用户拍板，卡片「分类徽标 + 同名
 * 标签」两行呈现是接受的特例）。
 */
const STAGE_CATEGORY_TERMS = [
  '需求与规划',
  '开发与实现',
  '质量与安全',
  '代码清理',
  '运维与协作',
  '测试自动化',
];
/** 作废的受众词：出现在 catalog tags 里也不进 category、并且要从自由标签洗掉。 */
const AUDIENCE_TAGS = ['官方', '社区'];
/**
 * 已作废的历史词表词：不再进 category，但**同样要从自由标签洗掉**——
 * - 「开学季」：上游 catalog 有 31 条内置的 tags 带它，只按现行词表洗会让它以普通标签身份
 *   回流分片 tags（卡片又长出同款「伪分类」标签，且分片内容级漂移）。
 * - 「质量保障」（0925 树化作废）：导入/上游数据里它仍可能出现在 tags，继续剔；
 *   category 面它由 0018 直映射「质量与安全」，生成器两源都不许再产出该值。
 * 与 skill-categories.ts 的 RETIRED_CATEGORY_TERMS 逐项一致（比对锁在 builtin-skills.test ⑥）。
 */
const RETIRED_CATEGORY_TERMS = ['开学季', '质量保障'];

/**
 * 上游 catalog 的 category 纠偏/补正表（人工判定，不改 catalog）。
 * docs/v0.0.4/skills-data/qwen-skills-catalog.json 是千问原始导出（带上游 skillId），
 * 绝对不许改；缺分类词属于上游数据缺陷、首词盲取也会取错，补正只能留在这里这一层。
 * 两类条目：
 * ① 「缺分类词」型（C-2 / 0024）：skill-creator 上游 tags 为空 {}，categoryFromTags 算不出，
 *    人工归「实用工具」（技能创建向导）。
 * ② 「0015 首词盲取存量错值」型（0925 拍板一）：季节/运营占位词（开学季、推荐）与内容词
 *    同现时，category 应取内容词，而「tags 首个词表词」的回填规则取走了占位词；唯一例外
 *    proactive-paper-recommendation（论文推荐引擎，「推荐」就是其真语义内容词，教育学习是
 *    占位误取）。其余 30 条多词技能与 3 条两可（financial-analysis-18steps /
 *    tailored-resume-generator / interview-prep）维持现状、不进本表。
 * 0925 第四片（词表删「开学季」）后本表 12 → 10 条：原「code-mentor 开学季→开发编程」「deep-research
 * 开学季→资讯研究」两条已随词表缩短变成 no-op——「开学季」不再在词表内，首词规则会自然跳过它
 * 直接算出内容词（补正值 = 首词结果，正是防呆要报错的形状），已删。原 10 条不变，「推荐」仍在
 * 词表内，excel/pptx 等「推荐→X」纠偏与占位词无关，继续有效。
 * 0925 树化（Q3 拍板）+3 条：prd / prd-generator / brainstorming（技术方案梳理）与 coding 批次
 * 「需求与规划」内容同质，从「方案写作」（首词规则算出的占位在案值）改判「编码开发/需求与规划」
 * 叶子——补正值 ≠ 首词计算值，是本表合法有效条目（防呆见下）。
 */
const CATEGORY_FIXES = {
  'skill-creator': '实用工具',
  'excel': 'Office办公',
  'pptx': 'Office办公',
  'guizang-ppt-skill': 'Office办公',
  'doc-image-scan': 'Office办公',
  'html-gen': '开发编程',
  'daily-news-briefing': '资讯研究',
  'pic-report': '资讯研究',
  'self-finance-report': '投资理财',
  'research-data-analysis-visualization': '数据分析',
  'proactive-paper-recommendation': '推荐',
  'prd': '需求与规划',
  'prd-generator': '需求与规划',
  'brainstorming': '需求与规划',
};

/** 与 skill-categories.ts 的 categoryFromTags 同口径（= 0015 回填 SQL 的判定）。 */
function categoryFromTags(tags) {
  for (const tag of tags) {
    if (!tag || AUDIENCE_TAGS.includes(tag)) continue;
    if (SKILL_CATEGORIES.includes(tag)) return tag;
  }
  return '';
}

/**
 * 与 skill-categories.ts 的 freeTagsOf 同口径（**0925 树化后的剔除集合**：受众词 ∪
 * (16 叶子 − 六个阶段词) ∪ 作废词）：「标签是标签，分类是分类」——非阶段叶子词、受众词与
 * 作废词都不留，其余原序保留；**六个产研阶段词是双角色豁免词，有意不洗**（用户拍板：既是
 * 分类叶子又合法留在 tags，31 条 coding 的阶段标签靠这条豁免活下来；不变量
 * tags ∩ (叶子 − 阶段词) = ∅）。内置终态：93 条千问洗后 tags 为空数组、31 条 coding
 * 原样带阶段标签，都是预期终态。
 */
function freeTagsOf(tags) {
  return tags.filter(
    (tag) =>
      !AUDIENCE_TAGS.includes(tag) &&
      !(SKILL_CATEGORIES.includes(tag) && !STAGE_CATEGORY_TERMS.includes(tag)) &&
      !RETIRED_CATEGORY_TERMS.includes(tag),
  );
}

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const apiRoot = path.resolve(scriptDir, '..');
const repoRoot = path.resolve(apiRoot, '../..');
const mdDir = path.join(apiRoot, 'src/skills/builtin-skills');
const catalogPath = path.join(repoRoot, 'docs/v0.0.4/skills-data/qwen-skills-catalog.json');
const codingCatalogPath = path.join(repoRoot, 'docs/0925/coding-skills-catalog.json');
const LIMIT = 24576;
const CHUNK_SIZE = 10;

/** 千问原始导出：slug 不得重复（重复会让 bySlug 静默吞条目）。 */
const catalog = JSON.parse(readFileSync(catalogPath, 'utf8'));
const bySlug = new Map();
for (const item of catalog) {
  if (bySlug.has(item.slug)) throw new Error(`千问 catalog 重复 slug：${item.slug}`);
  bySlug.set(item.slug, item);
}

/**
 * 0925 编码技能目录（第二源）：category/tags 显式给定、source 只作溯源留档。
 * slug 不得与千问源重复（同一内置管线一个 slug 只能有一份正文/分类口径）。
 */
const codingCatalog = JSON.parse(readFileSync(codingCatalogPath, 'utf8'));
const codingBySlug = new Map();
for (const item of codingCatalog) {
  if (codingBySlug.has(item.slug)) throw new Error(`coding 目录重复 slug：${item.slug}`);
  if (bySlug.has(item.slug)) throw new Error(`coding 目录与千问 catalog slug 重复：${item.slug}`);
  codingBySlug.set(item.slug, item);
}

const mdSlugs = readdirSync(mdDir)
  .filter((f) => f.endsWith('.md'))
  .map((f) => f.slice(0, -3))
  .sort();
/** coding 目录多余条目（无正文 md）构建期报错——md ⇔ coding 目录必须双向一一对应。 */
for (const item of codingCatalog) {
  if (!mdSlugs.includes(item.slug)) throw new Error(`coding 目录多余条目（builtin-skills/ 缺正文 md）：${item.slug}`);
}

/** builtin-skills/ 下存在正文 md 即迁移收编；两份目录之一必须有同名条目。 */
const rows = mdSlugs.map((slug) => {
  const coding = codingBySlug.get(slug);
  const item = bySlug.get(slug);
  if (!item && !coding) throw new Error(`两份目录都缺少 slug：${slug}`);
  const markdown = readFileSync(path.join(mdDir, `${slug}.md`), 'utf8');
  const bytes = Buffer.byteLength(markdown, 'utf8');
  if (bytes > LIMIT) throw new Error(`${slug} 正文 ${bytes}B 超 24K 上限，先裁剪再分片`);
  if (coding) {
    // coding 源：category/tags 显式给定，只校验不折算（0925 Q2 拍板：category 由目录
    // 逐条给定、与 tags 解耦，「叶子=tags 首词」机械规则作废）。
    if (!SKILL_CATEGORIES.includes(coding.category)) {
      throw new Error(`${slug} coding 目录 category 不在 16 叶子词表：${JSON.stringify(coding.category)}`);
    }
    if (!STAGE_CATEGORY_TERMS.includes(coding.category)) {
      throw new Error(
        `${slug} coding 目录 category 必须是六个产研阶段叶子之一（编码批次只在「编码开发」域）：${JSON.stringify(coding.category)}`,
      );
    }
    const tags = coding.tags;
    if (!Array.isArray(tags) || tags.length === 0 || tags.some((t) => typeof t !== 'string' || !t)) {
      throw new Error(`${slug} coding 目录 tags 必须是非空字符串数组（0925 收录要求带产研阶段标签）`);
    }
    // tags 必须原样通过 freeTagsOf（阶段词豁免；非阶段叶子词/作废词/受众词不许混进来），
    // 含即口径违规，报错而非静默洗掉。
    if (freeTagsOf(tags).length !== tags.length) {
      const purged = tags.filter((t) => !freeTagsOf([t]).includes(t));
      throw new Error(`${slug} coding 目录 tags 含非阶段叶子/作废/受众词，无法原样通过 freeTagsOf：${purged.join(', ')}`);
    }
    const desc = String(coding.description || '').trim();
    if (!desc) throw new Error(`${slug} coding 目录缺 description`);
    if (!String(coding.nameCn || '').trim()) throw new Error(`${slug} coding 目录缺 nameCn`);
    return { slug, nameCn: coding.nameCn, description: desc.slice(0, 500), category: coding.category, tags, markdown };
  }
  const desc = (item.desc || '').trim() || String(item.summary || '').split(/[。\n]/)[0];
  // catalog.tags 是 {中文分类词: 英文key} 形态，词表判定只看 key（顺序即数组序）。
  const rawTags = Object.keys(item.tags || {}).filter(Boolean);
  const category = CATEGORY_FIXES[slug] ?? categoryFromTags(rawTags);
  // 内置技能不允许未分类：空串或词表外一律构建期失败，绝不产出 category='' 的分片
  // （0015 的列级 CHECK 会在运行期把脏数据挡成启动失败，这里提前到生成期）。
  if (!SKILL_CATEGORIES.includes(category)) {
    throw new Error(`${slug} 未取到词表内分类（category=${JSON.stringify(category)}），补 CATEGORY_FIXES 或修 catalog`);
  }
  const tags = freeTagsOf(rawTags);
  return { slug, nameCn: item.nameCn, description: desc.slice(0, 500), category, tags, markdown };
});
// 补正表防呆：条目必须存在（已收编）、且必须是「有效纠偏」——补正值 ≠ categoryFromTags
// 首词规则算出的值。两类都适用：缺词型算出 ''、补上词表词才算有效；0925 纠偏型算出
// 占位词/误取值、改成真语义词才算有效。上游哪天修好了 tags 使首词规则直接算出正确值，
// 这条补正就成了 no-op——报错提示清理，绝不静默覆盖（也防手滑填成与首词相同的废条目）。
// 0925 双源后本表只作用于千问源：coding 源 category 本就直接给定，补正无从谈起，混进
// 来即多余条目，报错。
for (const slug of Object.keys(CATEGORY_FIXES)) {
  const row = rows.find((item) => item.slug === slug);
  if (!row) throw new Error(`CATEGORY_FIXES 多余条目（未收编）：${slug}`);
  if (codingBySlug.has(slug)) throw new Error(`CATEGORY_FIXES 只许收千问源 slug（coding 源 category 显式给定）：${slug}`);
  const computed = categoryFromTags(Object.keys(bySlug.get(slug).tags || {}).filter(Boolean));
  if (CATEGORY_FIXES[slug] === computed) {
    throw new Error(`CATEGORY_FIXES 已多余：${slug} 首词规则已直接算出 ${JSON.stringify(computed)}，删掉这条补正`);
  }
}

// 清掉旧分片（数量可能变），再按 10 条一片写出。
for (const f of readdirSync(path.join(apiRoot, 'src/skills'))) {
  if (/^builtin-skills\.data(\.\d+)?\.ts$/.test(f)) rmSync(path.join(apiRoot, 'src/skills', f));
}
const chunkFiles = [];
for (let i = 0; i < rows.length; i += CHUNK_SIZE) {
  const n = i / CHUNK_SIZE + 1;
  const file = `builtin-skills.data.${n}.ts`;
  const body = JSON.stringify(rows.slice(i, i + CHUNK_SIZE));
  writeFileSync(
    path.join(apiRoot, 'src/skills', file),
    `/* 自动生成（scripts/gen-builtin-seeds.mjs），勿手改：改 builtin-skills/*.md 或 skills-data 目录清单后重跑生成器。 */\nexport const BUILTIN_CHUNK_${n}: string = ${JSON.stringify(body)};\n`,
  );
  chunkFiles.push({ n, file: `builtin-skills.data.${n}` });
}
writeFileSync(
  path.join(apiRoot, 'src/skills', 'builtin-skills.data.ts'),
  [
    '/* 自动生成（scripts/gen-builtin-seeds.mjs），勿手改。 */',
    ...chunkFiles.map((c) => `import { BUILTIN_CHUNK_${c.n} } from './${c.file}';`),
    '',
    `export const BUILTIN_SKILL_CHUNKS: string[] = [${chunkFiles.map((c) => `BUILTIN_CHUNK_${c.n}`).join(', ')}];`,
    '',
  ].join('\n'),
);
console.log(`[gen-builtin-seeds] ${rows.length} 条 → ${chunkFiles.length} 个分片（正文合计 ${rows.reduce((s, r) => s + Buffer.byteLength(r.markdown), 0)}B）`);
const dist = rows.reduce((acc, r) => ((acc[r.category] = (acc[r.category] || 0) + 1), acc), {});
console.log(
  `[gen-builtin-seeds] category 分布：${Object.entries(dist).sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k}=${v}`).join(' ')}`,
);
console.log(`[gen-builtin-seeds] 剩余自由标签非空条数：${rows.filter((r) => r.tags.length > 0).length}`);
