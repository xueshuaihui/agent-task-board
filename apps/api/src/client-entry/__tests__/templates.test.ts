import { describe, expect, it } from 'vitest';
import {
  CLIENT_ENTRY_MARKER_BEGIN,
  CLIENT_IDS,
  type ClientId,
} from '../../contract/client-entry';
import { MCP_SERVER_NAME, MCP_WAKE_WORD } from '../../mcp/wake';
import { renderRule, renderSkill } from '../templates';

const SKILL_CLIENTS: ClientId[] = ['qoder', 'cursor', 'claude_code', 'codex'];
const SKILL_TOOLS = [
  'board.create_task',
  'board.create_tasks_batch',
  'get_vocabulary',
  'list_ready_tasks',
  'claim_next_task',
  'requirement.execution_rules',
  'update_progress',
  'append_log',
  'heartbeat',
  'complete_task',
  'fail_task',
  'block_task',
  'wait_for_resume',
  'board.begin_breakdown',
  'report_progress',
  'report_task_draft',
  'finish_breakdown',
  'wait_for_breakdown',
  'search_skills',
  'get_skill',
  'structuredContent',
];

describe('renderRule', () => {
  it.each(CLIENT_IDS)('%s 的规则包含唤醒词、服务名、自检与兜底提示', (client) => {
    const { body } = renderRule(client);
    expect(body).toContain(MCP_WAKE_WORD);
    expect(body).toContain(MCP_SERVER_NAME);
    expect(body).toContain('wake_probe');
    expect(body).toContain(`\`source\` 传 \`${client}\``);
    expect(body).toContain('当前会话模式');
    expect(body).toContain('无关');
    expect(body).toContain('设置 → 客户端入口');
    expect(body).toContain('MCP 连接');
  });

  it.each(CLIENT_IDS)('%s 的规则不写 URL/端口/token，也不含 CRLF 与托管标记', (client) => {
    const { body, frontmatter } = renderRule(client);
    const full = frontmatter === undefined ? body : `${frontmatter}\n${body}`;
    expect(full).not.toContain('http://');
    expect(full).not.toContain('https://');
    expect(full).not.toContain(':7788');
    expect(full.toLowerCase()).not.toContain('token');
    expect(full).not.toContain('\r');
    expect(full).not.toContain(CLIENT_ENTRY_MARKER_BEGIN);
    expect(body.length).toBeLessThan(800);
    expect(full.length).toBeLessThan(800);
  });

  it('Cursor 使用 alwaysApply frontmatter', () => {
    expect(renderRule('cursor').frontmatter).toBe(
      '---\ndescription: Jarvis Workbench 唤醒入口\nalwaysApply: true\n---',
    );
  });

  it('Windsurf 使用 always_on frontmatter', () => {
    expect(renderRule('windsurf').frontmatter).toBe('---\ntrigger: always_on\n---');
  });

  it.each(['qoder', 'cline', 'claude_code', 'codex'] as const)('%s 的规则没有 frontmatter', (client) => {
    expect(renderRule(client).frontmatter).toBeUndefined();
  });
});

describe('renderSkill', () => {
  it.each(SKILL_CLIENTS)('%s 的技能 frontmatter 与正文齐全', (client) => {
    const { body, frontmatter } = renderSkill(client);
    expect(frontmatter).toBeDefined();
    if (frontmatter === undefined) throw new Error('expected frontmatter');
    expect(frontmatter.startsWith('---\n')).toBe(true);
    expect(frontmatter.endsWith('\n---')).toBe(true);
    expect(frontmatter).toContain('name: jarvis-workbench');
    expect(frontmatter).toContain('description:');
    expect(frontmatter).toMatch(/[\u4e00-\u9fa5]/);
    expect(frontmatter).not.toContain('\r');

    for (const tool of SKILL_TOOLS) expect(body).toContain(tool);
    expect(body).toContain('# Jarvis Workbench 操作手册');
    expect(body).not.toContain('\r');
    expect(body).not.toContain(CLIENT_ENTRY_MARKER_BEGIN);
    expect(`${frontmatter}\n${body}`.length).toBeLessThan(6000);
  });

  it('Cline / Windsurf 不支持技能', () => {
    expect(() => renderSkill('cline')).toThrow(/不支持技能/);
    expect(() => renderSkill('windsurf')).toThrow(/不支持技能/);
  });
});
