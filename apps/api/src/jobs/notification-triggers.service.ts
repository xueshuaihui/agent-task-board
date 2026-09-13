import { Injectable } from '@nestjs/common';
import { ApiException } from '../contract/errors';
import type { NotificationKind } from '../contract/enums';
import { PrismaService } from '../infra/prisma.service';
import { NotificationsService } from '../infra/notifications.service';

/**
 * 6.7 五类通知里还没人落库的三个触发点（review_pending / run_failed / review_rejected）。
 *
 * 触发代码本身在别人的路径里（ATB-1 的 complete/fail、审核接口），跨目录改不动，
 * 所以这里只把「怎么写这条通知」收口一处：文案、标题补全、6.7 的重复抑制。
 * 调用方一行 `await this.triggers.reviewPending(taskId)` 即可。
 *
 * lease_expired 划给 ATB-1 的租约回收定时器，task_unblocked 在 DependencyUnlockService，
 * 两者都调本文件的 pushOnce，不各自抄一份判重。
 */
@Injectable()
export class NotificationTriggers {
  constructor(
    private readonly prisma: PrismaService,
    private readonly notifications: NotificationsService,
  ) {}

  /** 6.5 / 10.2：Run 成功回写、任务进入待审核后调用。 */
  async reviewPending(taskId: string, title?: string): Promise<string | null> {
    return this.pushOnce(
      'review_pending',
      taskId,
      `${taskId} 进入待审核${await this.suffix(taskId, title)}`,
    );
  }

  /** 4.3.2 / 6.7：Run 回写为失败（含 Agent 自报失败）后调用。 */
  async runFailed(
    taskId: string,
    options?: { runId?: string | null; reason?: string | null; title?: string },
  ): Promise<string | null> {
    const run = options?.runId ? `（${options.runId}）` : '';
    const detail = options?.reason ? `：${options.reason}` : '';
    return this.pushOnce(
      'run_failed',
      taskId,
      `${taskId} 执行失败${run}${detail}${await this.suffix(taskId, options?.title)}`,
    );
  }

  /** 6.6 / 6.7：审核结论 REJECT（驳回与退回重跑都算，4.3.1 规则 5）后调用。 */
  async reviewRejected(
    taskId: string,
    options?: { opinion?: string | null; title?: string },
  ): Promise<string | null> {
    const opinion = options?.opinion ? `：${options.opinion}` : '';
    return this.pushOnce(
      'review_rejected',
      taskId,
      `${taskId} 审核被驳回${opinion}${await this.suffix(taskId, options?.title)}`,
    );
  }

  /**
   * 6.7「同一任务同一 kind 已有未读时不重复插入」：已读过的才算新事件。
   * 文档还要求这种情况下把 created_at 顶到当前，但写 notifications 表的动作归
   * infra/NotificationsService.push（本文件不直写），所以这里只做插入抑制。
   */
  async pushOnce(kind: NotificationKind, taskId: string, message: string): Promise<string | null> {
    const pending = await this.prisma.notification.findFirst({
      where: { kind, taskId, readAt: null },
      select: { id: true },
    });
    if (pending) return null;
    return this.notifications.push(kind, taskId, message);
  }

  /** 面板文案带标题才可读（10.2）；调用方没传就补一次单行查询。 */
  private async suffix(taskId: string, title?: string): Promise<string> {
    if (title) return ` · ${title}`;
    const row = await this.prisma.task.findUnique({ where: { id: taskId }, select: { title: true } });
    if (!row) {
      throw new ApiException('NOT_FOUND', `通知目标任务不存在：${taskId}`, undefined, { task_id: taskId });
    }
    return row.title ? ` · ${row.title}` : '';
  }
}
