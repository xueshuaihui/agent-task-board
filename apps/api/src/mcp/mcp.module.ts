import { Module } from '@nestjs/common';
import { AgentModule } from '../agent/agent.module';
import { BreakdownModule } from '../breakdown/breakdown.module';
import { CreationModule } from '../creation/creation.module';
import { SkillsModule } from '../skills/skills.module';
import { McpController } from './mcp.controller';

/**
 * 鉴权不在此处装配：app.module 已把 AuthGuard 注册为全局 APP_GUARD，
 * `@AuthScope('agent')` 在 McpController 上即可生效，MCP 与 REST 走的是同一份 Token 校验
 *（含 capabilities 解析与 last_used_at 节流）。
 * W6 §16.1 技能三工具直接注入 SkillsModule 的 SkillsService（AgentModule 只 import 未 re-export）。
 * W7 §16.1 board.* 拆解五工具注入 BreakdownModule 的 BreakdownService（与 REST 确认页同一实现）。
 * W8 §8.7 board.create_task 注入 CreationModule 的 CreationService（会话/流水落库在同一事务）。
 */
@Module({
  imports: [AgentModule, SkillsModule, BreakdownModule, CreationModule],
  controllers: [McpController],
})
export class McpModule {}
