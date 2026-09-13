import { Global, Module } from '@nestjs/common';
import { AuditService } from './audit.service';
import { EventsService } from './events.service';
import { AppLogger, sharedAppLogger } from './logger';
import { NotificationsService } from './notifications.service';
import { PrismaService } from './prisma.service';
import { SettingsService } from './settings.service';

const providers = [
  PrismaService,
  // 工厂而不是类：日志器必须在 Nest 容器之前就被 main.ts 用到，两处必须拿到同一个实例。
  { provide: AppLogger, useFactory: () => sharedAppLogger() },
  SettingsService,
  AuditService,
  EventsService,
  NotificationsService,
];

@Global()
@Module({
  providers,
  exports: providers,
})
export class InfraModule {}
