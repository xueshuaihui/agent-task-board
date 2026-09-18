import { Injectable } from '@nestjs/common';
import { newId } from '../contract/ids';
import type { NotificationKind } from '../contract/enums';
import { nowSql, toIso } from '../contract/time';
import { BUILTIN_ACCOUNT_ID } from '../auth/accounts.service';
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
    // 0919：通知按账号隔离。有任务的从任务取归属；无任务的（目前没有）落内置账号。
    let accountId = BUILTIN_ACCOUNT_ID;
    if (taskId) {
      const task = await this.prisma.task.findUnique({ where: { id: taskId }, select: { accountId: true } });
      accountId = task?.accountId ?? accountId;
    }
    await this.prisma.notification.create({
      data: { id, kind, taskId, message, accountId },
    });
    this.events.emit('notification.created', {
      id,
      kind,
      task_id: taskId,
      unread_count: await this.prisma.notification.count({ where: { readAt: null, accountId } }),
    });
    return id;
  }

  async list(accountId: string, unreadOnly: boolean) {
    const items = await this.prisma.notification.findMany({
      where: { accountId, ...(unreadOnly ? { readAt: null } : {}) },
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
      unread_count: await this.prisma.notification.count({ where: { readAt: null, accountId } }),
    };
  }

  async markRead(accountId: string, ids: string[] | null, all: boolean): Promise<{ updated: number }> {
    const where = all
      ? { accountId, readAt: null }
      : { accountId, id: { in: ids ?? [] }, readAt: null };
    const result = await this.prisma.notification.updateMany({
      where,
      data: { readAt: nowSql() },
    });
    return { updated: result.count };
  }
}
