import { Body, Controller, Get, Post, Query } from '@nestjs/common';
import type { z } from 'zod';
import { notificationsQuerySchema } from '../contract/schemas';
import { Auth, AuthScope, type RequestAuth } from '../auth/auth.scope';
import { NotificationsService } from '../infra/notifications.service';
import { zod } from '../infra/zod.pipe';
import { type MarkReadInput, markReadBodySchema } from './notifications.dto';

/** contract 未导出这条查询串的入参类型（该文件冻结），在本模块就地推导，不另写一份形状。 */
type NotificationsQuery = z.infer<typeof notificationsQuerySchema>;

/**
 * 13 章通知接口。列表的 `unread_count` 同时是顶栏铃铛与托盘角标的数字（10.4），
 * 所以两处共用这一个读端点，不各算各的。面板 UI 属阶段二，接口先到位。
 */
@Controller('api/v1/notifications')
@AuthScope('ui')
export class NotificationsApiController {
  constructor(private readonly notifications: NotificationsService) {}

  @Get()
  list(@Query(zod(notificationsQuerySchema)) query: NotificationsQuery, @Auth() auth: RequestAuth) {
    return this.notifications.list(auth.accountId, query.unread === 'true');
  }

  /**
   * 标记已读不返回 `unread_count`：13 章的角标更新只走 `notification.created`，
   * 已读后的数字由前端重取一次列表，服务端不在这里再造第二条通道。
   */
  @Post('read')
  markRead(@Body(zod(markReadBodySchema)) body: MarkReadInput, @Auth() auth: RequestAuth) {
    return this.notifications.markRead(auth.accountId, body.ids ?? null, body.all === true);
  }
}
