import { Module } from '@nestjs/common';
import { SkillsModule } from '../skills/skills.module';
import { CreationController } from './creation.controller';
import { CreationService } from './creation.service';

/**
 * v0.0.4 W8 会话创建闭环模块：
 *  · 服务层 CreationService——board.create_task 三模式（direct/silent 即时落库，
 *    light 待决请求 + 决策闭环，§8.7 r3）；
 *  · REST 面 CreationController——/api/v1/creation-requests 列表 / 生成 / 决策（§16.2，UI 凭证组）；
 *  · MCP board.create_task / get_creation_status / wait_for_confirmation（Agent 面）在 McpModule
 *    注入本模块导出的 CreationService；技能名→ID 解析复用 SkillsModule 的 SkillsService。
 */
@Module({
  imports: [SkillsModule],
  controllers: [CreationController],
  providers: [CreationService],
  exports: [CreationService],
})
export class CreationModule {}
