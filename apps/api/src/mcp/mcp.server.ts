import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { ApiException } from '../contract/errors';
import { appVersion } from '../common/version';
import type { RequestAuth } from '../auth/auth.scope';
import { buildAgentTools, parseToolInput, type AgentToolContext } from './agent-tools';

export type { AgentToolContext };

/** MCP Server 的标识名，客户端配置里的 `agent-task-board` 与它对应（10.2）。 */
export const MCP_SERVER_NAME = 'agent-task-board';

/**
 * 每个 HTTP 请求一个新实例：无状态 Streamable HTTP 要求 server 与 transport 成对短命，
 * 更重要的是 Token 上下文（tokenId / capabilities）是请求级的，跨请求复用会把
 * A Token 的能力集合泄漏给 B Token（20.5 的可见性判定依赖它）。
 */
export function createAgentMcpServer(auth: RequestAuth, ctx: AgentToolContext): McpServer {
  const server = new McpServer({ name: MCP_SERVER_NAME, version: appVersion });
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
