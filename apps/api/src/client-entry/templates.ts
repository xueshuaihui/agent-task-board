import type { ClientId } from '../contract/client-entry';
import { MCP_SERVER_NAME, MCP_WAKE_WORD } from '../mcp/wake';

/**
 * 入口模板只有一份来源：唤醒词与服务名取自 `mcp/wake.ts`，避免规则里的「贾维斯」
 * 和 MCP initialize 下发的口径分叉。模板本身不含托管标记与 frontmatter 顺序，
 * installer 负责把它们拼成最终文件（frontmatter 永远在最前）。
 */

export interface RenderedAsset {
  body: string;
  frontmatter?: string;
}

const CURSOR_FRONTMATTER = [
  '---',
  'description: Jarvis Workbench 唤醒入口',
  'alwaysApply: true',
  '---',
].join('\n');

const WINDSURF_FRONTMATTER = ['---', 'trigger: always_on', '---'].join('\n');

const SKILL_FRONTMATTER = [
  '---',
  `name: ${MCP_SERVER_NAME}`,
  `description: 当用户说「${MCP_WAKE_WORD}」或要求操作 Jarvis Workbench 看板（创建/领取/回写/拆解任务）时使用。`,
  '---',
].join('\n');

/**
 * 规则必须短：它会被客户端塞进每一轮上下文。这里只写「何时进入、用哪个工具、
 * 模式听谁的、什么时候不要调用」，操作细节全部留给按需加载的技能。
 * 特别不能写 URL/端口/token——那些随安装环境变化，写死就会过期。
 */
function renderRuleBody(client: ClientId): string {
  return [
    '# Jarvis Workbench 唤醒入口',
    '',
    `当用户消息以「${MCP_WAKE_WORD}」开头，或明确呼唤「${MCP_WAKE_WORD}」时：`,
    `1. 进入 Jarvis Workbench 工作模式：直接使用已连接的 \`${MCP_SERVER_NAME}\` MCP 工具完成请求，不要反问是否使用工具。`,
    `2. 用户说「${MCP_WAKE_WORD}，自检」时，调用 \`wake_probe\` 工具，\`source\` 传 \`${client}\`，然后一句话告知结果。`,
    `3. 本轮完成后是否保持工作模式，以工具响应末尾的「【${MCP_WAKE_WORD}】当前会话模式」为准。`,
    '4. 与看板无关的对话不要调用该服务工具；工具不可用时，提示用户打开「设置 → 客户端入口」检查安装与 MCP 连接。',
  ].join('\n');
}

const SKILL_BODY = [
  '# Jarvis Workbench 操作手册',
  '',
  '- 创建：`board.create_task` / `board.create_tasks_batch`；先 `get_vocabulary` 取词表。',
  '- 领取：`list_ready_tasks` → `claim_next_task`；领取后先读 `requirement.execution_rules`。',
  '- 执行：`update_progress`（0-5% → 10-90% → 100%，至少每 2-3 分钟）、`append_log`、`heartbeat`。',
  '- 完成/失败：`complete_task` / `fail_task`；需要人工时 `block_task`，恢复用 `wait_for_resume`。',
  '- 拆解：`board.begin_breakdown` → `report_progress` → `report_task_draft` → `finish_breakdown` → `wait_for_breakdown`。',
  '- 技能：`search_skills` → `get_skill`；多候选时让用户选，不自行拍定。',
  '- 错误：按 structuredContent 的 code/message 处理；不要自行猜字段或审核方式。',
].join('\n');

export function renderRule(client: ClientId): RenderedAsset {
  const body = renderRuleBody(client);
  if (client === 'cursor') return { body, frontmatter: CURSOR_FRONTMATTER };
  if (client === 'windsurf') return { body, frontmatter: WINDSURF_FRONTMATTER };
  // Qoder / Cline / Claude Code / Codex 的 markdown 不需要前置 frontmatter；
  // 后两者整份文件由 installer 用托管块包起来。
  return { body };
}

export function renderSkill(client: ClientId): RenderedAsset {
  if (client === 'cline' || client === 'windsurf') {
    throw new Error(`${client} 不支持技能资产，调用方应先检查 adapter.assets`);
  }
  return { body: SKILL_BODY, frontmatter: SKILL_FRONTMATTER };
}
