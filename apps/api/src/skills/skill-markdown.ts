import type { SkillContent } from './skills.dto';

/**
 * SKILL.md / .mdc <-> blocks 双向转换（1.md 8.7，源码模式导入导出）。
 *
 * 这份实现是前端 apps/web/src/features/skills/markdown.ts 的**逐行镜像**（转换约定
 * 完全一致），因为前端产物不接 Nest 编译链、无法直接 import。两边改动必须同步，
 * 往返一致性（blocks→markdown→blocks）由测试锁定。
 *
 * 无损策略：每个块的小节第一行写 HTML 注释标记 `<!-- atb:kind -->`，
 * 导入时优先按标记还原；无标记的历史 Markdown 按内容形状推断（损失性）。
 */

/** 与前端 SkillFrontmatter 一致。 */
export interface SkillFrontmatter {
  /**
   * v0.0.4 W2 r2（§9.2）：技能唯一 ID 终身不变、随导出持久——导出必带；
   * 无 id 的历史文件导入时可选（缺省按新技能分配）。
   */
  id?: string;
  name: string;
  description: string;
  version: string;
  category: string;
  tags: string[];
  mcpDependencies: unknown[];
}

/** 与前端 SkillBlockKind 一致（1.md 8.3 的 15 类）。 */
type BlockKind =
  | 'prompt' | 'step' | 'decision' | 'loop' | 'parallel' | 'tool' | 'knowledge'
  | 'script' | 'subskill' | 'human' | 'input' | 'output' | 'constraint'
  | 'error_handler' | 'comment';

const BLOCK_KIND_SET = new Set<string>([
  'prompt', 'step', 'decision', 'loop', 'parallel', 'tool', 'knowledge',
  'script', 'subskill', 'human', 'input', 'output', 'constraint',
  'error_handler', 'comment',
]);

/** 与前端 meta.ts 的 createBlock 同一套 id 规则与字段基座。 */
function createBlock(kind: BlockKind, seedIndex: number): Record<string, unknown> {
  const id = `block-${Date.now().toString(36)}-${seedIndex}`;
  const base: Record<string, unknown> = { id, kind, title: '' };
  if (kind === 'prompt' || kind === 'knowledge') base.prompt = '';
  if (kind === 'step' || kind === 'loop') base.steps = [];
  if (kind === 'decision') {
    base.condition = '';
    base.next = [
      { when: '是', to: '' },
      { when: '否', to: '' },
    ];
  }
  if (kind === 'loop') base.while = '';
  if (kind === 'parallel') {
    base.merge = 'all';
    base.branches = [''];
  }
  if (kind === 'human') base.humanInstruction = '';
  if (kind === 'tool') {
    base.server = '';
    base.tool = '';
  }
  if (kind === 'script') base.script = '';
  if (kind === 'subskill') base.skillRef = '';
  if (kind === 'constraint') base.rule = '';
  if (kind === 'error_handler') {
    base.onError = 'abort';
    base.retryCount = 3;
    base.timeoutMs = 60000;
  }
  if (kind === 'comment') base.note = '';
  return base;
}

/* ---------------------------------- 序列化 --------------------------------- */

interface BlockLike {
  id: string;
  kind: string;
  title: string;
  [key: string]: unknown;
}

function blockToMarkdown(block: BlockLike, resolveTitle: (id: string) => string): string {
  const lines: string[] = [];
  lines.push(`### ${block.title || block.id}`, '', `<!-- atb:${block.kind} -->`, '');

  switch (block.kind) {
    case 'prompt':
    case 'knowledge':
      lines.push((block.prompt as string) ?? '');
      break;
    case 'step':
      lines.push(...(((block.steps as string[]) ?? []).map((step, index) => `${index + 1}. ${step}`)));
      break;
    case 'decision': {
      lines.push(`判断条件：${block.condition ?? ''}`, '');
      for (const next of (block.next as { when: string; to: string }[]) ?? []) {
        lines.push(`- 当 ${next.when || '…'} → 跳转：${next.to ? resolveTitle(next.to) : '（结束）'}`);
      }
      break;
    }
    case 'loop':
      lines.push(`循环条件：${block.while ?? ''}`, '');
      lines.push(...(((block.steps as string[]) ?? []).map((step) => `- ${step}`)));
      break;
    case 'parallel':
      lines.push(`合并策略：${block.merge ?? 'all'}`, '');
      lines.push(...(((block.branches as string[]) ?? []).map((branch) => `- ${branch}`)));
      break;
    case 'tool':
      lines.push(`工具：${block.server ?? ''}/${block.tool ?? ''}`);
      if (block.argsTemplate) lines.push(`参数模板：${block.argsTemplate}`);
      break;
    case 'script':
      lines.push('```', (block.script as string) ?? '', '```');
      break;
    case 'subskill':
      lines.push(`引用技能：${block.skillRef ?? ''}`);
      break;
    case 'human':
      lines.push((block.humanInstruction as string) ?? '');
      break;
    case 'input':
    case 'output':
      lines.push(
        `${block.kind === 'input' ? '输入' : '输出'}：${block.name ?? ''}（类型 ${block.valueType ?? 'string'}${block.required ? '，必填' : ''}）`,
      );
      break;
    case 'constraint':
      lines.push(`规则：${block.rule ?? ''}`);
      break;
    case 'error_handler': {
      const parts = [`失败策略：${block.onError ?? 'abort'}`];
      if (block.onError === 'retry' && block.retryCount != null) parts.push(`重试 ${block.retryCount} 次`);
      if (block.timeoutMs != null) parts.push(`超时 ${block.timeoutMs}ms`);
      lines.push(parts.join('，'));
      break;
    }
    case 'comment':
      lines.push((block.note as string) ?? '');
      break;
  }
  return lines.join('\n');
}

/**
 * SKILL.md 标准的 version 是纯 semver（0.1.0）：内部存储带 v 前缀（v0.1.0），
 * 导出时去掉；导入侧 parseFrontmatter 同样归一化，两种写法都兼容。
 */
function toSemver(version: string): string {
  return version.replace(/^v(?=\d)/, '');
}

/** frontmatter 用 YAML 子集：标量与单行数组，mcp_dependencies 用行内 JSON。 */
export function blocksToMarkdown(content: SkillContent, frontmatter: SkillFrontmatter): string {
  const titleOf = (id: string) =>
    content.blocks.find((block) => block.id === id)?.title || id;
  const fmLines = [
    '---',
    // r2：id 随行导出，分享出去的 SKILL.md 再导入按同 id 识别为同一技能。
    ...(frontmatter.id ? [`id: ${frontmatter.id}`] : []),
    `name: ${frontmatter.name}`,
    `description: ${frontmatter.description.replace(/\n/g, ' ')}`,
    `version: ${toSemver(frontmatter.version)}`,
    `category: ${frontmatter.category}`,
    `tags: [${frontmatter.tags.join(', ')}]`,
  ];
  if (frontmatter.mcpDependencies.length > 0) {
    fmLines.push(`mcp_dependencies: ${JSON.stringify(frontmatter.mcpDependencies)}`);
  }
  fmLines.push('---', '');

  const entry = content.entryBlockId
    ? (content.blocks.find((block) => block.id === content.entryBlockId)?.title ?? content.entryBlockId)
    : '';
  const body = content.blocks.map((block) => blockToMarkdown(block as BlockLike, titleOf)).join('\n\n');
  const entryLine = entry ? [`入口块：${entry}`, ''] : [];
  return [...fmLines, ...entryLine, body].join('\n');
}

/* ---------------------------------- 解析 ----------------------------------- */

export function parseFrontmatter(source: string): { frontmatter: SkillFrontmatter | null; body: string } {
  const match = /^---\n([\s\S]*?)\n---\n?/.exec(source);
  if (!match) return { frontmatter: null, body: source };
  const raw = match[1];
  const body = source.slice(match[0].length);
  const get = (key: string): string => {
    const line = raw.split('\n').find((item) => item.startsWith(`${key}:`));
    return line ? line.slice(key.length + 1).trim() : '';
  };
  const parseList = (key: string): string[] => {
    const value = get(key);
    if (!value) return [];
    const inner = value.replace(/^\[/, '').replace(/\]$/, '');
    return inner
      .split(',')
      .map((item) => item.trim().replace(/^['"]|['"]$/g, ''))
      .filter(Boolean);
  };
  let mcp: unknown[] = [];
  const mcpRaw = get('mcp_dependencies');
  if (mcpRaw) {
    try {
      const parsed: unknown = JSON.parse(mcpRaw);
      if (Array.isArray(parsed)) mcp = parsed;
    } catch {
      /* 损坏就丢弃，导入提示里统一说明 */
    }
  }
  return {
    frontmatter: {
      id: get('id') || undefined,
      name: get('name'),
      description: get('description'),
      version: toSemver(get('version')),
      category: get('category'),
      tags: parseList('tags'),
      mcpDependencies: mcp,
    },
    body,
  };
}

function parseOnError(value: string): string {
  return ['abort', 'retry', 'skip', 'fallback', 'continue'].find((item) => item === value) ?? 'abort';
}

/** 无 kind 标记时按内容形状推断（损失性）。 */
function inferKind(section: string): { kind: BlockKind; warnings: string[] } {
  const warnings: string[] = [];
  if (/^工具：/m.test(section)) return { kind: 'tool', warnings };
  if (/^```/m.test(section)) return { kind: 'script', warnings };
  if (/^引用技能：/m.test(section)) return { kind: 'subskill', warnings };
  if (/^(输入|输出)：/m.test(section)) return { kind: /^输入：/m.test(section) ? 'input' : 'output', warnings };
  if (/^规则：/m.test(section)) return { kind: 'constraint', warnings };
  if (/^失败策略：/m.test(section)) return { kind: 'error_handler', warnings };
  if (/^循环条件：/m.test(section)) return { kind: 'loop', warnings };
  if (/^合并策略：/m.test(section)) return { kind: 'parallel', warnings };
  if (/^- 当 /m.test(section) || /^判断条件：/m.test(section)) return { kind: 'decision', warnings };
  if (/^\d+\. /m.test(section)) return { kind: 'step', warnings };
  warnings.push('无 atb 标记的小节按「提示词块」导入，类型可能不准');
  return { kind: 'prompt', warnings };
}

function parseSection(title: string, text: string, resolveId: (title: string) => string): {
  block: Record<string, unknown>;
  warnings: string[];
} {
  const marker = /<!--\s*atb:([a-z_]+)\s*-->/.exec(text);
  let kind: BlockKind;
  let warnings: string[] = [];
  if (marker && BLOCK_KIND_SET.has(marker[1])) {
    kind = marker[1] as BlockKind;
  } else {
    const inferred = inferKind(text);
    kind = inferred.kind;
    warnings = inferred.warnings;
  }

  const listItems = (pattern = /^[-*] (.+)$/gm): string[] => {
    const items: string[] = [];
    for (const match of text.matchAll(pattern)) items.push(match[1].trim());
    return items;
  };
  const firstLine = (prefix: string): string => {
    const line = text.split('\n').find((item) => item.startsWith(prefix));
    return line ? line.slice(prefix.length).trim() : '';
  };
  /** 去掉 atb 标记注释行，返回正文文本。 */
  const bodyText = (): string =>
    text
      .split('\n')
      .filter((line) => !line.trim().startsWith('<!--'))
      .join('\n')
      .trim();

  /** 列表项为空时把整段正文兜底成一条，避免手写文档的段落内容被静默丢弃。 */
  const listOrBody = (items: string[], prefix: string): string[] => {
    if (items.length > 0) return items;
    const prose = bodyText();
    if (!prose) return [];
    warnings.push(`${prefix}「${title}」没有列表项，已把整段正文作为一条导入`);
    return [prose];
  };

  const block: Record<string, unknown> = { id: '', kind, title };
  switch (kind) {
    case 'prompt':
    case 'knowledge':
      block.prompt = bodyText();
      break;
    case 'step': {
      const numbered = [...text.matchAll(/^\d+\. (.+)$/gm)].map((match) => match[1].trim());
      block.steps = listOrBody(numbered.length > 0 ? numbered : listItems(), '步骤块');
      break;
    }
    case 'decision': {
      block.condition = firstLine('判断条件：');
      block.next = [...text.matchAll(/^[-*] 当 (.+?) → 跳转：(.+)$/gm)].map((match) => {
        /* 导出把终态写成「（结束）」，导入回来同样是终态，不能算「目标找不到」。 */
        const named = match[2].trim().replace(/^（(.*)）$/, '$1');
        const to = resolveId(named);
        if (named && !to && named !== '结束') {
          warnings.push(`分支跳转目标「${named}」在文档里找不到，已保留为空，可在可视化模式补齐`);
        }
        return { when: match[1].trim(), to };
      });
      if ((block.next as unknown[]).length === 0) {
        block.next = [
          { when: '是', to: '' },
          { when: '否', to: '' },
        ];
      }
      break;
    }
    case 'loop':
      block.while = firstLine('循环条件：');
      block.steps = listOrBody(listItems(), '循环块');
      break;
    case 'parallel': {
      const merge = firstLine('合并策略：');
      block.merge = (['all', 'any', 'race'] as const).find((item) => item === merge) ?? 'all';
      block.branches = listOrBody(listItems(), '并行块');
      break;
    }
    case 'tool': {
      const toolLine = firstLine('工具：');
      const slashIndex = toolLine.indexOf('/');
      block.server = slashIndex >= 0 ? toolLine.slice(0, slashIndex) : toolLine;
      block.tool = slashIndex >= 0 ? toolLine.slice(slashIndex + 1) : '';
      block.argsTemplate = firstLine('参数模板：');
      break;
    }
    case 'script': {
      const code = /^```[^\n]*\n([\s\S]*?)\n```/m.exec(text);
      block.script = code ? code[1] : text.trim();
      break;
    }
    case 'subskill':
      block.skillRef = firstLine('引用技能：');
      break;
    case 'human':
      block.humanInstruction = bodyText();
      break;
    case 'input':
    case 'output': {
      const declared = firstLine(kind === 'input' ? '输入：' : '输出：');
      const nameMatch = /^([^(（]*)/.exec(declared);
      block.name = (nameMatch?.[1] ?? '').trim();
      block.valueType = /类型 (\w+)/.exec(declared)?.[1] ?? 'string';
      block.required = kind === 'input' ? /必填/.test(declared) : false;
      break;
    }
    case 'constraint':
      block.rule = firstLine('规则：');
      break;
    case 'error_handler': {
      const policy = firstLine('失败策略：');
      block.onError = parseOnError(policy);
      block.retryCount = /重试 (\d+) 次/.exec(policy)?.[1] != null ? Number(/重试 (\d+) 次/.exec(policy)?.[1]) : undefined;
      block.timeoutMs = /超时 (\d+)ms/.exec(policy)?.[1] != null ? Number(/超时 (\d+)ms/.exec(policy)?.[1]) : undefined;
      break;
    }
    case 'comment':
      block.note = bodyText();
      break;
  }
  return { block, warnings };
}

export interface MarkdownImportResult {
  frontmatter: SkillFrontmatter | null;
  content: SkillContent;
  /** 损失性转换提示（哪些信息没能还原）。 */
  warnings: string[];
}

/** 从 markdown 解析回 blocks + frontmatter。约定与前端 markdownToBlocks 完全一致。 */
export function markdownToBlocks(source: string): MarkdownImportResult {
  const { frontmatter, body } = parseFrontmatter(source);
  const warnings: string[] = [];

  // 小节切分：### 开头。### 前的非空正文（若有）并进警告。
  const sections: { title: string; text: string }[] = [];
  const headingRe = /^### (.+)$/gm;
  const matches = [...body.matchAll(headingRe)];
  const preambleLines = body
    .slice(0, matches[0]?.index ?? body.length)
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line !== '' && !line.startsWith('入口块：') && !/^---$/.test(line));
  if (preambleLines.length > 0) warnings.push('小节标题（###）之前的正文未导入');
  for (let i = 0; i < matches.length; i += 1) {
    const start = (matches[i].index ?? 0) + matches[i][0].length;
    const end = matches[i + 1]?.index ?? body.length;
    sections.push({ title: matches[i][1].trim(), text: body.slice(start, end) });
  }

  const titleToId = new Map<string, string>();
  const built: Record<string, unknown>[] = [];
  for (const section of sections) {
    const block = createBlock('prompt', built.length);
    block.title = section.title;
    built.push(block);
    titleToId.set(section.title, block.id as string);
  }
  const resolveId = (title: string): string => titleToId.get(title) ?? '';
  let index = 0;
  for (const section of sections) {
    const parsed = parseSection(section.title, section.text, resolveId);
    warnings.push(...parsed.warnings);
    built[index] = { ...parsed.block, id: built[index].id };
    index += 1;
  }

  // 入口块
  const entryTitle = /^入口块：(.+)$/m.exec(body)?.[1]?.trim();
  const firstId = typeof built[0]?.id === 'string' ? (built[0].id as string) : null;
  const entryBlockId = entryTitle ? (titleToId.get(entryTitle) ?? firstId) : firstId;
  if (entryTitle && !titleToId.has(entryTitle)) warnings.push(`入口块「${entryTitle}」未找到，已回退为第一个块`);

  return {
    frontmatter,
    content: { blocks: built as SkillContent['blocks'], entryBlockId },
    warnings: [...new Set(warnings)],
  };
}
