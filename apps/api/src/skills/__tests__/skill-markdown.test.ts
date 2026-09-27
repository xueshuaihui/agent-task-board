import { describe, expect, it } from 'vitest';
import { markdownToBlocks, parseFrontmatter } from '../skill-markdown';

/**
 * 解析边界的换行归一（Windows 侧防线）：用户在 Windows 上写的 SKILL.md/.mdc 多为 CRLF，
 * frontmatter 开合正则 `^---\n` 要求字面 \n、正文多行体经 split('\n').join('\n') 会把 `\r`
 * 留在行间——不处理则整段解析错位且 `\r` 漏进 id/name/version。这些用例只喂字符串，
 * 不依赖 Windows，macOS 上即跑即验；断言全部指向「CRLF 与 LF 同解」。
 */

const LF_DOC = [
  '---',
  'id: skl_crlf-01',
  'name: 跨换行技能',
  'description: 验证 CRLF 解析',
  'version: v1.2.3',
  'category: 研发',
  'tags: [评审, 研发]',
  '---',
  '',
  '入口块：开场',
  '',
  '### 开场',
  '',
  '<!-- atb:prompt -->',
  '',
  '第一行',
  '第二行',
  '',
  '### 步骤',
  '',
  '<!-- atb:step -->',
  '',
  '1. 读 diff',
  '2. 写意见',
  '',
].join('\n');

const CRLF_DOC = LF_DOC.replace(/\n/g, '\r\n');

describe('skill-markdown 换行归一（CRLF 解析）', () => {
  it('parseFrontmatter：CRLF 文档与 LF 逐字节同解（frontmatter 命中、body 已归一）', () => {
    expect(parseFrontmatter(CRLF_DOC)).toEqual(parseFrontmatter(LF_DOC));
    const { frontmatter } = parseFrontmatter(CRLF_DOC);
    expect(frontmatter).not.toBeNull();
    expect(frontmatter!.id).toBe('skl_crlf-01');
    expect(frontmatter!.name).toBe('跨换行技能');
    expect(frontmatter!.version).toBe('1.2.3');
    expect(frontmatter!.tags).toEqual(['评审', '研发']);
  });

  it('frontmatter 各字段不残留 \\r（未归一时开合正则根本不命中，只会得 frontmatter:null）', () => {
    const { frontmatter } = parseFrontmatter(CRLF_DOC);
    for (const value of [frontmatter!.id, frontmatter!.name, frontmatter!.description, frontmatter!.version, frontmatter!.category]) {
      expect(value ?? '').not.toContain('\r');
    }
  });

  it('markdownToBlocks：CRLF 多行提示词块按 \\n 连接、不夹带 \\r', () => {
    const { content } = markdownToBlocks(CRLF_DOC);
    const prompt = (content.blocks as Record<string, unknown>[]).find((block) => block.kind === 'prompt');
    expect(prompt!.prompt).toBe('第一行\n第二行');
    expect(JSON.stringify(content.blocks)).not.toContain('\\r');
  });

  it('markdownToBlocks：CRLF 步骤块列表项完整解出（`.` 不吃 \\r 会丢项，归一后与 LF 等长）', () => {
    const crlf = markdownToBlocks(CRLF_DOC).content.blocks as Record<string, unknown>[];
    const lf = markdownToBlocks(LF_DOC).content.blocks as Record<string, unknown>[];
    const stepsOf = (blocks: Record<string, unknown>[]) =>
      blocks.find((block) => block.kind === 'step')?.steps;
    expect(stepsOf(crlf)).toEqual(['读 diff', '写意见']);
    expect(stepsOf(crlf)).toEqual(stepsOf(lf));
  });
});
