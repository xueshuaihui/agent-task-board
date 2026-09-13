import { Module } from '@nestjs/common';
import { AgentModule } from '../agent/agent.module';
import { McpController } from './mcp.controller';

/**
 * 鉴权不在此处装配：app.module 已把 AuthGuard 注册为全局 APP_GUARD，
 * `@AuthScope('agent')` 在 McpController 上即可生效，MCP 与 REST 走的是同一份 Token 校验
 *（含 capabilities 解析与 last_used_at 节流）。
 */
@Module({
  imports: [AgentModule],
  controllers: [McpController],
})
export class McpModule {}
