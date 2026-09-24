import type { DefaultSkillSeed } from './default-skills';
import { markdownToBlocks } from './skill-markdown';
import { BUILTIN_SKILL_CHUNKS } from './builtin-skills.data';
import type { SkillCategory } from './skill-categories';
import type { SkillContent } from './skills.dto';

/**
 * v0.0.4 #41：千问工作台技能迁移批次（映射表口径见 docs/v0.0.4/千问技能迁移映射表.md）。
 *
 * 正文数据链路：docs/v0.0.4/skills-data 目录清单 + src/skills/builtin-skills/*.md
 * （降级改写/裁剪后的终稿，入库）→ scripts/gen-builtin-seeds.mjs 生成
 * builtin-skills.data.<n>.ts 分片（JSON 字符串常量，入库）→ 本模块启动期解析。
 * 选 .ts 分片而非运行时读 md：sidecar 是 webpack 单文件 bundle、nest build 不拷非 ts
 * 资源，fs 读 md 在打包态必挂；.ts 常量三态（dev ts-node / vitest / sidecar）一致。
 */

/** 与 blockSchema 的 prompt.max(20000) 对齐：兜底块按字符切片不越界。 */
const PROMPT_CHUNK_CHARS = 19000;

export interface BuiltinSkillRaw {
  slug: string;
  nameCn: string;
  description: string;
  /**
   * 单值分类（0015 列 + skill-categories.ts 两级树词表）：千问源由生成器按 catalog 原始 tags 取
   * 「首个非受众词且在词表内」的词得到（口径同 0015 回填 SQL），缺分类词或首词被占位词
   * 误取的条目走生成器里的显式补正表 CATEGORY_FIXES（0925 拍板一纠偏 + 树化 Q3 三条
   * 「方案写作→需求与规划」）；0925 编码技能收录的 31 条则在 docs/0925/coding-skills-catalog.json
   * 里显式给定（六个产研阶段叶子之一，Q2 拍板后与 tags 解耦）。两侧都构建期
   * 校验，因此分片内 category 必然 ∈ 16 叶子词表（内置技能不允许未分类）。
   */
  category: SkillCategory;
  /** 自由标签：千问源已洗掉作废的 官方/社区 与非阶段叶子词表词/作废词（0016 口径 + 0925 树化阶段词豁免，见 freeTagsOf 注释），其余原序保留（大量条目为空数组，预期终态）；0925 coding 源目录显式给定产研阶段词（双角色豁免词，合法保留；非阶段叶子/作废/受众词仍不得混入，构建期校验原样通过 freeTagsOf）。 */
  tags: string[];
  markdown: string;
}

export const BUILTIN_SKILLS_RAW: BuiltinSkillRaw[] = BUILTIN_SKILL_CHUNKS.flatMap((chunk) =>
  JSON.parse(chunk) as BuiltinSkillRaw[],
);

/** markdown→blocks；返回 null 表示该正文不适合走解析器（判据见 convertBuiltinMarkdown）。 */
function splitFallbackPrompt(text: string): string[] {
  if (text.length <= PROMPT_CHUNK_CHARS) return [text];
  const parts: string[] = [];
  let rest = text;
  while (rest.length > 0) {
    let cut = Math.min(rest.length, PROMPT_CHUNK_CHARS);
    const nl = rest.lastIndexOf('\n', cut);
    if (nl > PROMPT_CHUNK_CHARS / 2) cut = nl; // 尽量不切断行
    parts.push(rest.slice(0, cut));
    rest = rest.slice(cut);
  }
  return parts;
}

export interface BuiltinConversionResult {
  content: SkillContent;
  /** 'flow'=markdownToBlocks 无损解析成多块；'prompt'=单提示词块兜底（全文保留）。 */
  mode: 'flow' | 'prompt';
}

/**
 * 解析判据（镜像前端约定 + #41 迁移扩展）：
 * - 解析器按 ### 切块，会丢弃首个 ### 之前的正文（千问正文普遍以 # 标题+导语开头）。
 *   迁移侧把这段前言补成一个提示词块置于队首——全文无损，不改动解析器本体；
 * - 补块后仍不足 2 块（没有 ### 结构）或超 200 块（blockSchema 上限）走单提示词兜底
 *   （迁移口径：宁可保留，兜底也全文保留）。
 */
export function convertBuiltinMarkdown(raw: BuiltinSkillRaw): BuiltinConversionResult {
  const fallback = (): BuiltinConversionResult => {
    const parts = splitFallbackPrompt(raw.markdown);
    const blocks = parts.map((part, index) => ({
      id: index === 0 ? 'b-entry' : `b-more-${index}`,
      kind: 'prompt' as const,
      title: index === 0 ? raw.nameCn : `${raw.nameCn}（续${index}）`,
      prompt: part,
      next: [{ when: '', to: index === parts.length - 1 ? '' : `b-more-${index + 1}` }],
    }));
    return { content: { blocks, entryBlockId: 'b-entry' }, mode: 'prompt' };
  };
  const parsed = markdownToBlocks(raw.markdown);
  const blocks = [...parsed.content.blocks] as SkillContent['blocks'];
  if (parsed.warnings.some((w) => w.includes('小节标题（###）之前的正文未导入'))) {
    const preamble = raw.markdown.slice(0, raw.markdown.search(/^### /m)).trim();
    const firstId = blocks[0]?.id;
    if (preamble && firstId) {
      blocks.unshift({
        id: 'b-preamble',
        kind: 'prompt',
        title: raw.nameCn,
        prompt: preamble,
        next: [{ when: '', to: firstId }],
      } as SkillContent['blocks'][number]);
    }
  }
  const content: SkillContent = {
    blocks,
    entryBlockId: blocks.some((block) => block.id === parsed.content.entryBlockId)
      ? parsed.content.entryBlockId
      : (blocks[0]?.id ?? null),
  };
  if (content.blocks.length >= 2 && content.blocks.length <= 200 && content.entryBlockId) {
    return { content, mode: 'flow' };
  }
  return fallback();
}

/** 124 条内置迁移种子（93 千问迁移 + 0925 编码技能收录 31；id=skl_builtin_<slug>，与既有 code-review 同一 id 惯例）。 */
export const BUILTIN_SKILL_SEEDS: DefaultSkillSeed[] = BUILTIN_SKILLS_RAW.map((raw) => {
  const { content, mode } = convertBuiltinMarkdown(raw);
  return {
    id: `skl_builtin_${raw.slug}`,
    name: raw.slug,
    type: mode === 'flow' ? 'flow' : 'prompt',
    description: raw.description,
    // 分类与自由标签直接取分片值：生成器（scripts/gen-builtin-seeds.mjs）已按
    // skill-categories.ts 的口径算好 category，并把受众词与一切词表分类词从 tags 洗掉，
    // 这里不再做任何折算——上一代「按 source 折算 官方/社区」的写法就是本次收口要堵死的路。
    category: raw.category,
    tags: raw.tags,
    content,
    // 千问平台专属依赖已在清洗阶段降级写进正文说明，不造 MCP 依赖（迁移口径 3）。
    mcpDependencies: [],
  };
});
