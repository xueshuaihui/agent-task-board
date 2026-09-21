import { Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { AgentModule } from './agent/agent.module';
import { ArtifactsModule } from './artifacts/artifacts.module';
import { AuditApiModule } from './audit-api/audit-api.module';
import { AuthGuard } from './auth/auth.guard';
import { AuthModule } from './auth/auth.module';
import { BackupModule } from './backup/backup.module';
// v0.0.4 W7：需求拆解服务层（controller 端点在下一切片接入）。
import { BreakdownModule } from './breakdown/breakdown.module';
import { DataModule } from './data/data.module';
import { FieldDefsModule } from './field-defs/field-defs.module';
import { InfraModule } from './infra/infra.module';
import { JobsModule } from './jobs/jobs.module';
import { McpModule } from './mcp/mcp.module';
import { NotificationsApiModule } from './notifications-api/notifications-api.module';
import { GroupsModule } from './groups/groups.module';
import { SettingsApiModule } from './settings-api/settings-api.module';
import { SkillsModule } from './skills/skills.module';
import { TasksModule } from './tasks/tasks.module';
import { TemplatesModule } from './templates/templates.module';
import { TokensModule } from './tokens/tokens.module';
import { WsModule } from './ws/ws.module';

@Module({
  imports: [
    InfraModule,
    AuthModule,
    FieldDefsModule,
    // SkillsModule 先于 AgentModule：AgentQueryService 注入 SkillsService 解析任务绑定（10.3）。
    SkillsModule,
    // 字面量子路由（tasks/ready、tasks/claim）必须早于 TasksController 的 tasks/:id 注册，
    // 否则 `GET /tasks/ready` 会被当成 `:id = 'ready'` 抢走并落到 UI 凭证组。
    AgentModule,
    McpModule,
    TasksModule,
    BreakdownModule,
    TokensModule,
    SettingsApiModule,
    TemplatesModule,
    NotificationsApiModule,
    GroupsModule,
    AuditApiModule,
    ArtifactsModule,
    DataModule,
    BackupModule,
    WsModule,
    JobsModule,
  ],
  providers: [
    // 全局守卫：未标注 @AuthScope() 的接口一律按 UI 凭证组处理（13 章跨组拒绝的默认方向）。
    { provide: APP_GUARD, useClass: AuthGuard },
  ],
})
export class AppModule {}
