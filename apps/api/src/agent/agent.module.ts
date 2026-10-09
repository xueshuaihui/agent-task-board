import { Module } from '@nestjs/common';
import { InfraModule } from '../infra/infra.module';
import { SkillsModule } from '../skills/skills.module';
import { TasksModule } from '../tasks/tasks.module';
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
 * §16.1 `update_task` 的守卫在 WritebackService，落库复用 TasksService 的窄入口
 * `patchAsAgent`（字段校验只有一份）——这里 import `TasksModule` 只为拿 provider，
 * 不引入反向依赖（TasksModule 不认识 AgentModule），注册顺序由上面那条约束继续保证。
 */
@Module({
  imports: [InfraModule, SkillsModule, TasksModule],
  controllers: [AgentController],
  providers: [LeaseService, AgentQueryService, ClaimService, WritebackService, McpPolicyService],
  exports: [LeaseService, AgentQueryService, ClaimService, WritebackService, McpPolicyService],
})
export class AgentModule {}
