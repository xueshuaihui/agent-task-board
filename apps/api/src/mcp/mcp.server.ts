import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { ApiException } from '../contract/errors';
import { toApiExceptionFromError } from '../contract/db-errors';
import { appVersion } from '../common/version';
import { DEFAULT_SETTINGS } from '../contract/settings';
import type { RequestAuth } from '../auth/auth.scope';
import { assertNoRawReviewMode, buildAgentTools, parseToolInput, type AgentToolContext } from './agent-tools';
import { buildMcpInstructions, MCP_SERVER_NAME, wakeModeNotice, type McpWakeMode } from './wake';

export type { AgentToolContext };

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
      async (args: unknown) => {
        // Q4：未知键 review_mode/reviewMode 必须在 zod 解析（剥离未知键）之前显式拒。
        assertNoRawReviewMode(tool.name, args);
        const result = await toCallToolResult(() =>
          tool.run(parseToolInput(tool.input, args), auth),
        );
        // 模式块必须独立追加、不并进首块：不少客户端会对 content[0]/structuredContent
        // 做 JSON 解析，混入散文就砸了载荷通道（成功与 isError 结果同理）。
        return {
          ...result,
          content: [...result.content, { type: 'text' as const, text: wakeModeNotice(wakeMode) }],
        };
      },
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
  assertNoRawReviewMode(name, rawArgs);
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
    // 与 REST 出口同一份解码器（contract/db-errors.ts）：数据层的抛出（撞外键、库损坏、
    // 只读目录、缺列）在 Agent 面同样要拿到细化码，而不是「内部错误」这四个字。
    // 旧写法 `if (!(error instanceof ApiException)) throw error` 让非 ApiException 直接
    // 冒到 SDK 变成 JSON-RPC -32603，Agent 读不到 code，也就完全不知道该怎么改。
    const api = error instanceof ApiException ? error : toApiExceptionFromError(error);
    return {
      content: [{ type: 'text', text: JSON.stringify(api.toBody()) }],
      structuredContent: {
        code: api.code,
        message: api.message,
        ...api.context,
        // B6：details（含词表可接受值）与 content[0] 的 toBody 双通道对齐——不少客户端
        // 只解析 structuredContent，缺了它就拿不到「可选：…」继续试错。纯追加：
        // 12 章契约的 code/message 与 context 键原样在位，details 缺省时不造键。
        ...(api.details === undefined ? {} : { details: api.details }),
      },
      isError: true,
    };
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}
