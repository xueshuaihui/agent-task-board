import { Module } from '@nestjs/common';
import { SkillsModule } from '../skills/skills.module';
import { CreationService } from './creation.service';

/**
 * v0.0.4 W8 会话创建闭环模块：本切片只有服务层（board.create_task 的直建/静默落库）。
 * REST 决策端点（/creation-requests/*）与轻确认卡片随下一切片在本模块内接入。
 * MCP board.create_task 工具（Agent 面）在 McpModule 注入本模块导出的 CreationService；
 * 技能名→ID 解析复用 SkillsModule 的 SkillsService（绑定归一只有一份实现）。
 */
@Module({
  imports: [SkillsModule],
  controllers: [],
  providers: [CreationService],
  exports: [CreationService],
})
export class CreationModule {}
