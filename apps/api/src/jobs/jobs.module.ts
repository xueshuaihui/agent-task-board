import { Module } from '@nestjs/common';
import { AutoArchiveJob } from './auto-archive.job';
import { DependencyUnlockService } from './dependency-unlock.service';
import { NotificationTriggers } from './notification-triggers.service';

/**
 * 后台任务与 6.7 通知触发点。PrismaService / SettingsService / AuditService /
 * EventsService / NotificationsService 都来自 @Global() 的 InfraModule，无需 imports。
 *
 * 租约过期扫描（lease.expired + lease_expired）归 ATB-1，不在本模块重复实现。
 */
@Module({
  providers: [AutoArchiveJob, DependencyUnlockService, NotificationTriggers],
  exports: [AutoArchiveJob, DependencyUnlockService, NotificationTriggers],
})
export class JobsModule {}
