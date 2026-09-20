import { Injectable } from '@nestjs/common';
import { newId } from '../contract/ids';
import type { NotificationKind } from '../contract/enums';
import { nowSql, toIso } from '../contract/time';
import { EventsService } from './events.service';
import { PrismaService } from './prisma.service';

/** 6.7 的五类事件落库处；托盘角标与顶栏铃铛共用同一份 unread_count（10.4）。 */
@Injectable()
export class NotificationsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly events: EventsService,
  ) {}

  async push(kind: NotificationKind, taskId: string | null, message: string): Promise<string> {
    const id = newId();
    await this.prisma.notification.create({ data: { id, kind, taskId, message } });
    this.events.emit('notification.created', {
      id,
      kind,
      task_id: taskId,
      unread_count: await this.prisma.notification.count({ where: { readAt: null } }),
    });
    return id;
  }

  async list(unreadOnly: boolean) {
    const items = await this.prisma.notification.findMany({
      where: unreadOnly ? { readAt: null } : {},
      orderBy: { createdAt: 'desc' },
      take: 100,
    });
    return {
      items: items.map((item) => ({
        id: item.id,
        kind: item.kind,
        task_id: item.taskId,
        message: item.message,
        read_at: toIso(item.readAt),
        created_at: toIso(item.createdAt),
      })),
      unread_count: await this.prisma.notification.count({ where: { readAt: null } }),
    };
  }

  async markRead(ids: string[] | null, all: boolean): Promise<{ updated: number }> {
    const where = all ? { readAt: null } : { id: { in: ids ?? [] }, readAt: null };
    const result = await this.prisma.notification.updateMany({
      where,
      data: { readAt: nowSql() },
    });
    return { updated: result.count };
  }
}
