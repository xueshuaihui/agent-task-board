import { Module } from '@nestjs/common';
import { AutoArchiveJob } from './auto-archive.job';
import { BreakdownTimeoutJob } from './breakdown-timeout.job';
import { DependencyUnlockService } from './dependency-unlock.service';
import { NotificationTriggers } from './notification-triggers.service';

/**
 * 后台任务与 6.7 通知触发点。PrismaService / SettingsService / AuditService /
 * EventsService / NotificationsService 都来自 @Global() 的 InfraModule，无需 imports。
 *
 * 租约过期扫描（lease.expired + lease_expired）归 ATB-1，不在本模块重复实现。
 * W7 遗留 b2：拆解超时收敛（§7.7 断连 30 分钟 / 未确认 7 天 → interrupted）。
 */
@Module({
  providers: [AutoArchiveJob, BreakdownTimeoutJob, DependencyUnlockService, NotificationTriggers],
  exports: [AutoArchiveJob, BreakdownTimeoutJob, DependencyUnlockService, NotificationTriggers],
})
export class JobsModule {}
