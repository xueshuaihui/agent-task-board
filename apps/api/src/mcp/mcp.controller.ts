import { Controller, Delete, Get, Logger, Post, Req, Res } from '@nestjs/common';
import type { Request, Response } from 'express';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { uuidv7 } from '../contract/ids';
import { Auth, AuthScope, type RequestAuth } from '../auth/auth.scope';
import { AgentQueryService } from '../agent/agent-query.service';
import { ClaimService } from '../agent/claim.service';
import { LeaseService } from '../agent/lease.service';
import { McpPolicyService } from '../agent/mcp-policy.service';
import { WritebackService } from '../agent/writeback.service';
import { BreakdownService } from '../breakdown/breakdown.service';
import { CreationService } from '../creation/creation.service';
import { SkillsService } from '../skills/skills.service';
import { SettingsService } from '../infra/settings.service';
import { createAgentMcpServer, type AgentToolContext } from './mcp.server';

/**
 * 19.2 第 6 项（有状态 SSE 还是无状态 Streamable HTTP）未拍板，切换点集中在这一个常量上。
 * 改成 `'sse'` 时需要同时做三件事：
 *   1. 维护 sessionId → {server, transport} 的进程内映射，并把 sessionIdGenerator 用上；
 *   2. GET /mcp 不再回 405，改为按 `Mcp-Session-Id` 复用同一 transport 建独立事件流；
 *   3. DELETE /mcp 按 sessionId 关闭并清理该映射。
 * 无状态下每个 POST 自带完整的 JSON-RPC 交换，四家客户端的配置形态一致（10.2），不需要会话粘滞。
 */
const MCP_TRANSPORT: 'stateless' | 'sse' = 'stateless';

/** 10.2 / 12 章：MCP 端点 `http://127.0.0.1:7788/mcp`，Bearer Agent Token 鉴权（13 章跨组拒绝同样生效）。 */
@Controller('mcp')
@AuthScope('agent')
export class McpController {
  private readonly logger = new Logger('mcp');

  constructor(
    private readonly claims: ClaimService,
    private readonly leases: LeaseService,
    private readonly writeback: WritebackService,
    private readonly query: AgentQueryService,
    private readonly skills: SkillsService,
    private readonly policy: McpPolicyService,
    private readonly breakdown: BreakdownService,
    private readonly creation: CreationService,
    private readonly settings: SettingsService,
  ) {}

  @Post()
  async post(@Req() req: Request, @Res() res: Response, @Auth() auth: RequestAuth): Promise<void> {
    const context: AgentToolContext = {
      claims: this.claims,
      leases: this.leases,
      writeback: this.writeback,
      query: this.query,
      skills: this.skills,
      policy: this.policy,
      breakdown: this.breakdown,
      creation: this.creation,
      settings: this.settings,
    };
    // 每请求一个 server：Token 上下文（tokenId / capabilities）是请求级的，复用会串能力集合。
    // 唤醒模式同样每请求现读：mcp_wake_mode 在 20.9 标了 hot，SettingsService 有进程内缓存，
    // 用户在设置页改完，下一个 initialize 就是新措辞，不需要重启 sidecar。
    const server = createAgentMcpServer(auth, context, await this.settings.get('mcp_wake_mode'));
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: MCP_TRANSPORT === 'stateless' ? undefined : () => uuidv7(),
      enableJsonResponse: MCP_TRANSPORT === 'stateless',
    });
    // 客户端中途断开（Agent 轮询超时很常见）时释放实例，否则每个请求都留下一个 McpServer。
    res.on('close', () => {
      void transport.close();
      void server.close();
    });

    try {
      await server.connect(transport);
      await transport.handleRequest(req, res, req.body);
    } catch (error) {
      this.logger.error(`MCP 请求处理失败：${(error as Error)?.stack ?? String(error)}`);
      if (!res.headersSent) {
        res.status(500).json({ jsonrpc: '2.0', id: null, error: { code: -32603, message: '服务内部错误' } });
      }
    }
  }

  @Get()
  stream(@Res() res: Response): void {
    this.rejectStream(res);
  }

  @Delete()
  terminate(@Res() res: Response): void {
    this.rejectStream(res);
  }

  /** 无状态模式没有可订阅的独立流，按传输规范回 405（回 404 会让客户端以为端点不存在）。 */
  private rejectStream(res: Response): void {
    res.status(405).json({
      jsonrpc: '2.0',
      id: null,
      error: { code: -32000, message: '本服务以无状态 Streamable HTTP 运行，不支持独立 SSE 流' },
    });
  }
}
