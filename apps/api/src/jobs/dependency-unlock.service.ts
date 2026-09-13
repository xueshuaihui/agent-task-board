import { Injectable } from '@nestjs/common';
import { EventsService } from '../infra/events.service';
import { PrismaService } from '../infra/prisma.service';
import { NotificationTriggers } from './notification-triggers.service';

interface UnlockRow {
  id: string;
  title: string;
}

/** 重复触发的防重窗口大小：sidecar 单进程，几千条足够覆盖一天的 DONE 量。 */
const SEEN_MAX = 4096;

/**
 * 5.5 依赖解锁：某个任务变 DONE 后，扫描以它为 `blocks` 前置的下游，
 * 全部前置都已 DONE 的就是「刚解锁」，发 `task.unblocked` + `task_unblocked` 通知。
 *
 * SQL 判据与 5.4 的认领过滤完全一致（`NOT EXISTS ... dep.status != 'DONE'`），
 * 否则会出现「通知说可领取、Agent 领不到」的自相矛盾。
 * 只看 READY：BACKLOG 卡片本来就不可领取，解锁通知对它没有意义，
 * 也让本服务与 tasks.service 已有的 DONE 路径保持同一口径、不双发。
 */
@Injectable()
export class DependencyUnlockService {
  /** 进程内防重：同一 (前置, 下游) 只发一次，覆盖「Agent 带旧 lease 重复回写」这类重入。 */
  private readonly seen = new Set<string>();

  constructor(
    private readonly prisma: PrismaService,
    private readonly events: EventsService,
    private readonly triggers: NotificationTriggers,
  ) {}

  /**
   * 调用点：任何把任务写成 DONE 却**没有**走 TasksService.transition() 的路径
   * （ATB-1 的 run 回写成功、租约回收后补判等）。
   * 走 transition() 的路径已在内部发过事件，不要再调本方法。
   */
  async scanAndNotify(doneTaskId: string): Promise<string[]> {
    const dependents = await this.prisma.$queryRaw<UnlockRow[]>`
      SELECT t.id, t.title FROM tasks t
      WHERE t.archived_at IS NULL AND t.status = 'READY'
        AND EXISTS (
          SELECT 1 FROM task_dependencies d
          WHERE d.task_id = t.id AND d.depends_on = ${doneTaskId} AND d.type = 'blocks'
        )
        AND NOT EXISTS (
          SELECT 1 FROM task_dependencies d2 JOIN tasks dep ON dep.id = d2.depends_on
          WHERE d2.task_id = t.id AND d2.type = 'blocks' AND dep.status != 'DONE'
        )`;

    const unlocked: string[] = [];
    for (const row of dependents) {
      if (!this.markFresh(`${doneTaskId}|${row.id}`)) continue;
      this.events.emit('task.unblocked', { task_id: row.id });
      // 10.2 通知面板的文案格式：`T-1003 依赖已解锁`，标题一并带上，面板不必再查任务表。
      await this.triggers.pushOnce(
        'task_unblocked',
        row.id,
        `${row.id} 依赖已解锁 · ${row.title}（前置 ${doneTaskId} 已完成）`,
      );
      unlocked.push(row.id);
    }
    return unlocked;
  }

  /** 6.1 阻塞角标的服务端同源判据：还剩几个未满足的 blocks 前置。 */
  async remainingBlockers(taskId: string): Promise<number> {
    const rows = await this.prisma.$queryRaw<{ count: bigint | number }[]>`
      SELECT COUNT(*) AS count FROM task_dependencies d JOIN tasks dep ON dep.id = d.depends_on
      WHERE d.task_id = ${taskId} AND d.type = 'blocks' AND dep.status != 'DONE'`;
    return Number(rows[0]?.count ?? 0);
  }

  /** 解锁通知是给「当下这一次」的，删除依赖时不要求重建状态，故只在内存里记。 */
  private markFresh(key: string): boolean {
    if (this.seen.has(key)) return false;
    this.seen.add(key);
    if (this.seen.size > SEEN_MAX) {
      const oldest = this.seen.values().next().value;
      if (oldest !== undefined) this.seen.delete(oldest);
    }
    return true;
  }

  /** 测试与手工触发用：清掉防重窗口。 */
  resetDedupe(): void {
    this.seen.clear();
  }
}
