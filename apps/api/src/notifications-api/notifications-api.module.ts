import { Module } from '@nestjs/common';
import { NotificationsApiController } from './notifications-api.controller';

/** 读写逻辑在 `infra/notifications.service.ts`（全局导出），本模块只挂路由。 */
@Module({
  controllers: [NotificationsApiController],
})
export class NotificationsApiModule {}
