import { Injectable, type OnApplicationBootstrap, type OnModuleDestroy } from '@nestjs/common';
import { nowSql } from '../contract/time';
import { AuditService } from '../infra/audit.service';
import { EventsService } from '../infra/events.service';
import { AppLogger } from '../infra/logger';
import { PrismaService } from '../infra/prisma.service';
import { SettingsService } from '../infra/settings.service';

export interface AutoArchiveOutcome {
  /** 本次读到的阈值（天）。0 表示自动归档关闭。 */
  days: number;
  /** 命中「DONE 且超期」的任务数，含被规则 3 跳过的。 */
  scanned: number;
  archived: string[];
  /** 因仍是未完成任务的 blocks 前置而被跳过的任务，附下游 id 便于排查。 */
  skipped: { id: string; downstream: string[] }[];
  failed: string[];
}

interface CandidateRow {
  id: string;
  title: string;
  updated_at: string;
}

interface DependentRow {
  id: string;
}

const DAY_MS = 24 * 3600 * 1000;

/**
 * 9.3 + 6.13.2：自动归档后台任务，每天检查一次，把 `DONE` 且 `updated_at` 超过
 * `auto_archive_days` 的任务批量置 `archived_at`。
 *
 * 不复用 tasks.service 的 archive()：那条路径是用户动作，审计 actor 是 `user`，
 * 且命中规则 3 时抛 409；自动归档要的是 actor=`system` + 跳过并写 `archive_skipped`，
 * 所以这里的 SQL 与它保持同一条判据（同一份「未完成下游」定义），只换掉失败处理。
 */
@Injectable()
export class AutoArchiveJob implements OnApplicationBootstrap, OnModuleDestroy {
  private timer: NodeJS.Timeout | null = null;
  private running = false;

  constructor(
    private readonly prisma: PrismaService,
    private readonly settings: SettingsService,
    private readonly audit: AuditService,
    private readonly events: EventsService,
    private readonly logger: AppLogger,
  ) {}

  /**
   * 启动后先补跑一次：sidecar 由主进程按需拉起，可能活不到 24 小时，
   * 只挂 setInterval 的话「每天一次」在这类常驻桌面进程里等于never。
   */
  onApplicationBootstrap(): void {
    this.schedule(30_000, DAY_MS);
  }

  onModuleDestroy(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  schedule(firstDelayMs: number, periodMs: number): void {
    this.onModuleDestroy();
    const kickoff = setTimeout(() => void this.tick(), firstDelayMs);
    kickoff.unref();
    this.timer = setInterval(() => void this.tick(), periodMs);
    this.timer.unref();
  }

  /** 定时器入口：后台任务抛出去会变成 unhandledRejection，main.ts 会据此退出进程。 */
  private async tick(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      const outcome = await this.runOnce();
      this.logger.log(
        `自动归档：候选 ${outcome.scanned}，归档 ${outcome.archived.length}，跳过 ${outcome.skipped.length}，失败 ${outcome.failed.length}（阈值 ${outcome.days} 天）`,
        'jobs',
      );
    } catch (error) {
      this.logger.error(`自动归档本轮失败：${(error as Error).message}`, undefined, 'jobs');
    } finally {
      this.running = false;
    }
  }

  /** 导出来给测试与「设置页改完立刻回收」这类手动触发用；调用方自己保证不与定时器并发。 */
  async runOnce(now: Date = new Date()): Promise<AutoArchiveOutcome> {
    const days = await this.settings.get('auto_archive_days');
    const outcome: AutoArchiveOutcome = { days, scanned: 0, archived: [], skipped: [], failed: [] };
    // 20.9：`0` = 关闭，不是「归档全部」。
    if (days <= 0) {
      this.logger.log('自动归档已关闭（auto_archive_days=0）', 'jobs');
      return outcome;
    }

    const cutoff = nowSql(new Date(now.getTime() - days * DAY_MS));
    const candidates = await this.prisma.$queryRaw<CandidateRow[]>`
      SELECT id, title, updated_at FROM tasks
      WHERE status = 'DONE' AND archived_at IS NULL AND updated_at < ${cutoff}
      ORDER BY updated_at ASC`;
    outcome.scanned = candidates.length;
    if (candidates.length === 0) return outcome;

    for (const row of candidates) {
      try {
        const downstream = await this.unfinishedDependents(row.id);
        if (downstream.length > 0) {
          // 4.3.1 规则 3：前置被归档会造成「下游永久阻塞且看板不可见」的死锁，跳过并留痕。
          // 「不重试」= 本轮不再处理它；下游转 DONE 后下一次每日检查自然回收。
          await this.audit.record({
            actorType: 'system',
            actorName: 'auto_archive',
            action: 'archive_skipped',
            targetType: 'task',
            targetId: row.id,
            after: {
              reason: '仍是未完成任务的 blocks 前置',
              downstream: downstream.map((item) => item.id),
              auto_archive_days: days,
            },
          });
          outcome.skipped.push({ id: row.id, downstream: downstream.map((item) => item.id) });
          continue;
        }
        const stamped = nowSql(now);
        await this.prisma.task.update({
          where: { id: row.id },
          // 与手动归档写同一组列，避免同一状态在两处留下不同的列值。
          data: { archivedAt: stamped, updatedAt: stamped, leaseId: null, leaseExpiresAt: null },
        });
        await this.audit.record({
          actorType: 'system',
          actorName: 'auto_archive',
          action: 'task_archive',
          targetType: 'task',
          targetId: row.id,
          before: { status: 'DONE', archived_at: null, updated_at: row.updated_at },
          after: { archived_at: stamped, trigger: 'auto_archive' },
        });
        // 13 章载荷的键是 `task_id`（不是 `id`）：手动归档与这里同一形状，前端才只用一张失效表。
        this.events.emit('task.archived', { task_id: row.id, archived: true });
        outcome.archived.push(row.id);
      } catch (error) {
        // 单条失败不中断整轮：一轮里几十个任务时，一个坏数据不该拖垮回收。
        outcome.failed.push(row.id);
        this.logger.warn(`自动归档单条失败 ${row.id}：${(error as Error).message}`, 'jobs');
      }
    }
    return outcome;
  }

  /** 与 tasks.service.unfinishedDependents() 同一条 SQL 判据（4.3.1 规则 3）。 */
  private async unfinishedDependents(id: string): Promise<DependentRow[]> {
    return this.prisma.$queryRaw<DependentRow[]>`
      SELECT t.id
      FROM task_dependencies d
      JOIN tasks t ON t.id = d.task_id
      WHERE d.depends_on = ${id} AND d.type = 'blocks' AND t.status != 'DONE' AND t.archived_at IS NULL`;
  }
}
