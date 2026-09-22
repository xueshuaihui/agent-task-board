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
 */
import { readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

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
  const sourceTag = item.source === 'OFFICIAL' ? '官方' : '社区';
  const tags = [sourceTag, ...Object.keys(item.tags || {})].filter(Boolean);
  return { slug, nameCn: item.nameCn, description: desc.slice(0, 500), tags, markdown };
});

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
