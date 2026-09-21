import 'reflect-metadata';
import { HttpAdapterHost, Reflector } from '@nestjs/core';

import { AgentQueryService } from '../../agent/agent-query.service';
import { AgentController } from '../../agent/agent.controller';
import { ClaimService } from '../../agent/claim.service';
import { LeaseService } from '../../agent/lease.service';
import { McpPolicyService } from '../../agent/mcp-policy.service';
import { WritebackService } from '../../agent/writeback.service';
import { ArtifactSignService } from '../../artifacts/artifact-sign.service';
import { ArtifactsService } from '../../artifacts/artifacts.service';
import { ArtifactsController } from '../../artifacts/artifacts.controller';
import { SignedResourceMiddleware } from '../../artifacts/signed-resource.middleware';
import { AuditQueryService } from '../../audit-api/audit-query.service';
import { AuditApiController } from '../../audit-api/audit-api.controller';
import { AuthGuard } from '../../auth/auth.guard';
import { BackupService } from '../../backup/backup.service';
import { BackupController } from '../../backup/backup.controller';
import { BreakdownController } from '../../breakdown/breakdown.controller';
import { BreakdownService } from '../../breakdown/breakdown.service';
import { CreationService } from '../../creation/creation.service';
import { CreationController } from '../../creation/creation.controller';
import { DataService } from '../../data/data.service';
import { ImportService } from '../../data/import.service';
import { DataController } from '../../data/data.controller';
import { FieldDefsService } from '../../field-defs/field-defs.service';
import { FieldDefsController } from '../../field-defs/field-defs.controller';
import { AuditService } from '../../infra/audit.service';
import { EventsService } from '../../infra/events.service';
import { AppLogger } from '../../infra/logger';
import { NotificationsService } from '../../infra/notifications.service';
import { PrismaService } from '../../infra/prisma.service';
import { PrefsController } from '../../groups/prefs.controller';
import { GroupsController } from '../../groups/groups.controller';
import { GroupsService } from '../../groups/groups.service';
import { SettingsService } from '../../infra/settings.service';
import { AutoArchiveJob } from '../../jobs/auto-archive.job';
import { BreakdownTimeoutJob } from '../../jobs/breakdown-timeout.job';
import { DependencyUnlockService } from '../../jobs/dependency-unlock.service';
import { NotificationTriggers } from '../../jobs/notification-triggers.service';
import { McpController } from '../../mcp/mcp.controller';
import { NotificationsApiController } from '../../notifications-api/notifications-api.controller';
import { SettingsApiService } from '../../settings-api/settings-api.service';
import { SettingsApiController } from '../../settings-api/settings-api.controller';
import { TasksService } from '../../tasks/tasks.service';
import { RunsController, TasksController } from '../../tasks/tasks.controller';
import { TemplatesService } from '../../templates/templates.service';
import { TemplatesController } from '../../templates/templates.controller';
import { TokensService } from '../../tokens/tokens.service';
import { TokensController } from '../../tokens/tokens.controller';
import { WsGateway } from '../../ws/ws-gateway';
import { SkillsService } from '../../skills/skills.service';
import { SkillsController } from '../../skills/skills.controller';

/**
 * 为什么需要这张表
 * ────────────────
 * vitest 走 Vite/esbuild 转译 TS，而 esbuild 不实现 `emitDecoratorMetadata`
 * （`apps/api/tsconfig.json` 里那个开关只对 `nest build` 生效）。实测
 * `Reflect.getMetadata('design:paramtypes', Cls)` 在测试进程里恒为 `undefined`，
 * 于是 `NestFactory.create(AppModule)` 会在第一个带构造参数注入的类上抛
 * `UndefinedDependencyException`——不是产品缺陷，是转译链的缺口。
 *
 * 这里在 create() 之前把同一份构造参数声明补回 reflect 元数据，让测试跑的是
 * **真实的 AppModule**（含模块顺序、全局 APP_GUARD、ArtifactsModule 的中间件接线），
 * 而不是在测试里重写一遍 composition root。
 *
 * 防漂移：`declare()` 会拿 `Cls.length`（TS 编译后保留的形参个数）对账。实现侧一旦
 * 增删构造参数而这里没跟着改，bootstrap 立刻抛错，不会出现「注入成 undefined 然后在
 * 某个断言里莫名炸掉」的静默错位。
 */
type InjectableClass = abstract new (...args: never[]) => unknown;

let applied = false;

export function applyDiShim(): void {
  if (applied) return;
  applied = true;

  // ── infra（@Global()，其余模块都靠它）
  declare(SettingsService, [PrismaService]);
  declare(AuditService, [PrismaService]);
  declare(NotificationsService, [PrismaService, EventsService]);

  // ── auth / 0919 分组与偏好
  declare(AuthGuard, [Reflector, PrismaService]);
  declare(GroupsService, [PrismaService, AuditService, EventsService]);
  declare(GroupsController, [GroupsService]);
  declare(PrefsController, [PrismaService]);

  // ── agent / mcp
  declare(AgentQueryService, [PrismaService, SkillsService]);
  declare(SkillsService, [PrismaService]);
  declare(SkillsController, [SkillsService]);
  declare(McpPolicyService, [PrismaService, AuditService]);

  // index 5 由 @Inject(LEASE_SWEEP_OPTIONS) 自行声明，Object 只用来把数组撑到构造参数个数。
  declare(LeaseService, [PrismaService, SettingsService, AuditService, EventsService, NotificationsService, Object]);
  declare(ClaimService, [PrismaService, SettingsService, LeaseService, AuditService, EventsService, AgentQueryService]);
  declare(WritebackService, [PrismaService, LeaseService, AuditService, EventsService, NotificationsService, AgentQueryService]);
  declare(AgentController, [ClaimService, LeaseService, WritebackService, AgentQueryService]);
  declare(McpController, [ClaimService, LeaseService, WritebackService, AgentQueryService, SkillsService, McpPolicyService, BreakdownService, CreationService]);

  // ── tasks
  declare(TasksService, [
    PrismaService,
    SettingsService,
    AuditService,
    EventsService,
    NotificationsService,
    ArtifactsService,
    SkillsService,
    AppLogger,
  ]);
  declare(TasksController, [TasksService]);
  declare(RunsController, [TasksService]);

  // ── v0.0.4 W7 需求拆解
  declare(BreakdownService, [PrismaService, AuditService, EventsService]);
  declare(BreakdownController, [BreakdownService]);

  // ── v0.0.4 W8 会话创建闭环（board.create_task 服务层 + W8-a2 REST 决策端点 §16.2）
  declare(CreationService, [PrismaService, SettingsService, AuditService, EventsService, SkillsService, NotificationsService]);
  declare(CreationController, [CreationService]);

  // ── field-defs / templates / tokens
  declare(FieldDefsService, [PrismaService, AuditService, SettingsService]);
  declare(FieldDefsController, [FieldDefsService]);
  declare(TemplatesService, [PrismaService, AuditService, SettingsService]);
  declare(TemplatesController, [TemplatesService]);
  declare(TokensService, [PrismaService, AuditService]);
  declare(TokensController, [TokensService]);

  // ── settings / notifications / audit 读接口
  declare(SettingsApiService, [SettingsService, AuditService, AppLogger]);
  declare(SettingsApiController, [SettingsApiService]);
  declare(NotificationsApiController, [NotificationsService]);
  declare(AuditQueryService, [PrismaService]);
  declare(AuditApiController, [AuditQueryService]);

  // ── artifacts
  declare(ArtifactsService, [PrismaService, SettingsService, ArtifactSignService, AppLogger]);
  declare(ArtifactsController, [ArtifactsService]);
  declare(SignedResourceMiddleware, [ArtifactSignService]);

  // ── data / backup
  declare(DataService, [PrismaService, AuditService]);
  declare(BackupService, [PrismaService, AuditService, AppLogger]);
  declare(ImportService, [PrismaService, SettingsService, BackupService, AuditService, AppLogger]);
  declare(DataController, [DataService, ImportService]);
  declare(BackupController, [BackupService]);

  // ── jobs
  declare(AutoArchiveJob, [PrismaService, SettingsService, AuditService, EventsService, AppLogger]);
  declare(BreakdownTimeoutJob, [PrismaService, AuditService, AppLogger]);
  declare(NotificationTriggers, [PrismaService, NotificationsService]);
  declare(DependencyUnlockService, [PrismaService, EventsService, NotificationTriggers]);

  // ── ws：index 1/2 标了 @Optional()，index 3 由 @Inject(WS_GATEWAY_OPTIONS) 自行声明，
  //    这里的 Object 只用来把数组撑到构造参数的个数（Nest 按 index 覆盖）。
  declare(WsGateway, [EventsService, HttpAdapterHost, AppLogger, Object]);
}

function declare(cls: InjectableClass, tokens: unknown[]): void {
  const name = (cls as unknown as { name?: string }).name ?? 'anonymous';
  if (tokens.some((token) => token === undefined || token === null)) {
    throw new Error(`DI shim: ${name} 的依赖表里有 undefined（多半是循环 import）`);
  }
  // `length` 只数到第一个带默认值的形参之前，所以只能做下限对账。
  if ((cls as unknown as { length: number }).length > tokens.length) {
    throw new Error(
      `DI shim 与实现漂移：${name} 声明了 ${(cls as unknown as { length: number }).length} 个构造参数，但表里只给了 ${tokens.length} 个 token`,
    );
  }
  Reflect.defineMetadata('design:paramtypes', tokens, cls);
}
