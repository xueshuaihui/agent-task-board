import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { ApiException } from '../contract/errors';
import { appVersion } from '../common/version';
import { DEFAULT_SETTINGS, type Settings } from '../contract/settings';
import type { RequestAuth } from '../auth/auth.scope';
import { buildAgentTools, parseToolInput, type AgentToolContext } from './agent-tools';

export type { AgentToolContext };

/** MCP Server 的标识名，客户端配置里的 `agent-task-board` 与它对应（10.2）。 */
export const MCP_SERVER_NAME = 'agent-task-board';

/** #46 唤醒词：客户端 Agent 在对话里监测它，服务端把口径经 instructions 下发（见下）。 */
export const MCP_WAKE_WORD = '贾维斯';

/** #46 退出指令：连续模式下唯一的工作模式出口。 */
export const MCP_WAKE_EXIT = '退出贾维斯';

export type McpWakeMode = Settings['mcp_wake_mode'];

/**
 * #46：唤醒词的「听」发生在 MCP 客户端的对话里，服务端拦不到也放不了行，
 * 能做的只有把口径在 `initialize` 响应的 instructions 里说清楚——客户端读它，
 * 就像读系统提示一样。两种模式只差「一轮即退」与「保持到退出指令」这一句。
 * 长度有惯例约束（客户端会整段注入上下文），控制在千字内。
 */
export function buildMcpInstructions(mode: McpWakeMode): string {
  const exitRule =
    mode === 'continuous'
      ? `当前为连续模式：进入工作模式后保持，把后续请求继续当作看板操作处理，直到用户明确说「${MCP_WAKE_EXIT}」或同义的退出指令；退出时简短确认一次，此后不再主动调用工具。`
      : '当前为单次模式：本轮唤醒对应的操作完成后即退出工作模式，此后不含唤醒词的请求按普通对话处理。';
  return [
    '本服务提供 Jarvis Workbench 看板的 MCP 工具（任务创建、领取、回写、技能查询、需求拆解等）。',
    `唤醒词：「${MCP_WAKE_WORD}」。用户消息以它开头或明确呼唤它（如「${MCP_WAKE_WORD}，创建一个任务：明天发布」）时，进入 Jarvis Workbench 工作模式：直接用本服务的工具完成该请求，不要反问是否使用工具。`,
    exitRule,
    '与唤醒无关的普通对话，不要主动调用本服务的工具。',
    '模式可在应用「设置 → Token」的「贾维斯唤醒模式」中更改；改动在下一次连接（initialize）生效。',
  ].join('\n');
}

/**
 * 每个 HTTP 请求一个新实例：无状态 Streamable HTTP 要求 server 与 transport 成对短命，
 * 更重要的是 Token 上下文（tokenId / capabilities）是请求级的，跨请求复用会把
 * A Token 的能力集合泄漏给 B Token（20.5 的可见性判定依赖它）。
 *
 * `wakeMode` 由调用方从热设置里取（20.9 标 hot：改值后下一请求即生效，不必重启）；
 * 缺省取 20.9 默认值，让脱离 HTTP 装配的调用点（测试、脚本）不必自己凑一个设置源。
 */
export function createAgentMcpServer(
  auth: RequestAuth,
  ctx: AgentToolContext,
  wakeMode: McpWakeMode = DEFAULT_SETTINGS.mcp_wake_mode,
): McpServer {
  const server = new McpServer(
    { name: MCP_SERVER_NAME, version: appVersion },
    { instructions: buildMcpInstructions(wakeMode) },
  );
  for (const tool of buildAgentTools(ctx)) {
    server.registerTool(
      tool.name,
      { description: tool.description, inputSchema: tool.input.shape },
      async (args: unknown) => toCallToolResult(() => tool.run(parseToolInput(tool.input, args), auth)),
    );
  }
  return server;
}

/** 脱离 HTTP 直接调工具（测试、脚本、以后的诊断命令走这里，不复制一遍错误映射）。 */
export async function callAgentTool(
  ctx: AgentToolContext,
  auth: RequestAuth,
  name: string,
  rawArgs: unknown,
): Promise<unknown> {
  const tool = buildAgentTools(ctx).find((item) => item.name === name);
  if (!tool) throw new ApiException('NOT_FOUND', `未知 MCP 工具 ${name}`);
  return tool.run(parseToolInput(tool.input, rawArgs), auth);
}

/** 12 章通用契约：错误以 `isError: true` + `structuredContent.code` 承载同一份 13 章错误码。 */
export async function toCallToolResult(
  fn: () => Promise<unknown>,
): Promise<CallToolResult> {
  try {
    const data = await fn();
    const payload = data ?? null;
    return {
      content: [{ type: 'text', text: JSON.stringify(payload) }],
      structuredContent: isRecord(payload) ? payload : { result: payload },
    };
  } catch (error) {
    if (!(error instanceof ApiException)) throw error;
    return {
      content: [{ type: 'text', text: JSON.stringify(error.toBody()) }],
      structuredContent: { code: error.code, message: error.message, ...error.context },
      isError: true,
    };
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}
