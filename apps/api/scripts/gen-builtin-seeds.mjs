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
 * 受众词与一切词表词都不留，其余原序保留（内置洗后大量条目 tags 为空数组，是预期终态），
 * 权威口径见 src/skills/skill-categories.ts。0925 拍板一另起 CATEGORY_FIXES 纠偏段：
 * 12 条内置的 category 因 0015「首词盲取」取到季节/运营占位词（开学季/推荐）或误取的
 * 教育学习，经补正表改判内容词（例外：proactive-paper-recommendation 的「推荐」是真语义）。
 */
import { readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * 12 项分类词表：**必须与 src/skills/skill-categories.ts 的 SKILL_CATEGORIES 逐项一致**。
 * 生成器是纯 .mjs（构建期跑，不经过 ts 编译），没法 import TS 常量，所以这里留一份字面量；
 * 一致性由 src/skills/__tests__/builtin-skills.test.ts 正则抽取本数组与 TS 侧比对锁住。
 */
const SKILL_CATEGORIES = [
  '开学季',
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
  '质量保障',
];
/** 作废的受众词：出现在 catalog tags 里也不进 category、并且要从自由标签洗掉。 */
const AUDIENCE_TAGS = ['官方', '社区'];

/**
 * 上游 catalog 的 category 纠偏/补正表（人工判定，不改 catalog）。
 * docs/v0.0.4/skills-data/qwen-skills-catalog.json 是千问原始导出（带上游 skillId），
 * 绝对不许改；缺分类词属于上游数据缺陷、首词盲取也会取错，补正只能留在这里这一层。
 * 两类条目：
 * ① 「缺分类词」型（C-2 / 0024）：skill-creator 上游 tags 为空 {}，categoryFromTags 算不出，
 *    人工归「实用工具」（技能创建向导）。
 * ② 「0015 首词盲取存量错值」型（0925 拍板一）：季节/运营占位词（开学季、推荐）与内容词
 *    同现时，category 应取内容词，而「tags 首个词表词」的回填规则取走了占位词；下列 11 条
 *    为逐条人工判定。唯一例外 proactive-paper-recommendation（论文推荐引擎，「推荐」就是
 *    其真语义内容词，教育学习是占位误取）。
 *    其余 30 条多词技能与 3 条两可（financial-analysis-18steps / tailored-resume-generator /
 *    interview-prep）维持现状、不进本表。
 */
const CATEGORY_FIXES = {
  'skill-creator': '实用工具',
  'code-mentor': '开发编程',
  'deep-research': '资讯研究',
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
 * 与 skill-categories.ts 的 freeTagsOf 同口径（0925 拍板收紧 = 0016 洗数段）：受众词与
 * 一切词表分类词都不留，其余原序保留。「标签是标签，分类是分类」——词表词留在 tags 里
 * 会让卡片标签区（skill-card 的 tags.slice(0,3)）与搜索命中面把同一技能呈现成两套分类；
 * 绑定技能搜索不受影响（category 是独立命中面）。内置洗后 tags 多为空数组，是预期终态。
 */
function freeTagsOf(tags) {
  return tags.filter((tag) => !AUDIENCE_TAGS.includes(tag) && !SKILL_CATEGORIES.includes(tag));
}

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const apiRoot = path.resolve(scriptDir, '..');
const repoRoot = path.resolve(apiRoot, '../..');
const mdDir = path.join(apiRoot, 'src/skills/builtin-skills');
const catalogPath = path.join(repoRoot, 'docs/v0.0.4/skills-data/qwen-skills-catalog.json');
const LIMIT = 24576;
const CHUNK_SIZE = 10;

const catalog = JSON.parse(readFileSync(catalogPath, 'utf8'));
const bySlug = new Map(catalog.map((item) => [item.slug, item]));
const slugs = readdirSync(mdDir)
  .filter((f) => f.endsWith('.md'))
  .map((f) => f.slice(0, -3))
  .sort();

/** builtin-skills/ 下存在正文 md 即迁移收编；catalog 必须有同名条目。 */
const rows = slugs.map((slug) => {
  const item = bySlug.get(slug);
  if (!item) throw new Error(`catalog 缺少 slug：${slug}`);
  const markdown = readFileSync(path.join(mdDir, `${slug}.md`), 'utf8');
  const bytes = Buffer.byteLength(markdown, 'utf8');
  if (bytes > LIMIT) throw new Error(`${slug} 正文 ${bytes}B 超 24K 上限，先裁剪再分片`);
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
for (const slug of Object.keys(CATEGORY_FIXES)) {
  const row = rows.find((item) => item.slug === slug);
  if (!row) throw new Error(`CATEGORY_FIXES 多余条目（未收编）：${slug}`);
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
