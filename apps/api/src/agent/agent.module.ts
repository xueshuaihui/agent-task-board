import { Module } from '@nestjs/common';
import { InfraModule } from '../infra/infra.module';
import { SkillsModule } from '../skills/skills.module';
import { AgentController } from './agent.controller';
import { AgentQueryService } from './agent-query.service';
import { ClaimService } from './claim.service';
import { LeaseService } from './lease.service';
import { McpPolicyService } from './mcp-policy.service';
import { WritebackService } from './writeback.service';

/**
 * `AgentModule` 必须在 app.module 的 imports 里排在 `TasksModule` 之前：
 * TasksController 声明了 `GET api/v1/tasks/:id`，Express 按注册顺序匹配，
 * 晚注册的话 `GET api/v1/tasks/ready` 会被它当成 `:id = 'ready'` 抢走并回 404。
 */
@Module({
  imports: [InfraModule, SkillsModule],
  controllers: [AgentController],
  providers: [LeaseService, AgentQueryService, ClaimService, WritebackService, McpPolicyService],
  exports: [LeaseService, AgentQueryService, ClaimService, WritebackService, McpPolicyService],
})
export class AgentModule {}
