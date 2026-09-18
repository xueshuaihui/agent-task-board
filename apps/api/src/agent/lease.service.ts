import { Inject, Injectable, Logger, Optional, type OnModuleDestroy, type OnModuleInit } from '@nestjs/common';
import type { Task, TaskRun } from '@prisma/client';
import { ApiException, USER_COPY } from '../contract/errors';
import { durationMs, nowSql, toIso } from '../contract/time';
import { newId } from '../contract/ids';
import type { LeaseTriple } from './agent-inputs';
import { agentOf, type AgentAuth } from './agent-auth';
import type { RequestAuth } from '../auth/auth.scope';
import { AuditService } from '../infra/audit.service';
import { EventsService } from '../infra/events.service';
import { NotificationsService } from '../infra/notifications.service';
import { PrismaService } from '../infra/prisma.service';
import { SettingsService } from '../infra/settings.service';

/** 4.3.2：租约由后台每 30 秒扫描一次过期项。 */
export const LEASE_SWEEP_INTERVAL_MS = 30_000;

/**
 * 扫描周期的注入点，与 `ATB_WS_GATEWAY_OPTIONS` 同一套口径：
 * 生产（AppModule 直接装配）不提供这个 token，`@Optional()` 拿到 undefined，
 * 周期就是 4.3.2 那个 30 秒；只有测试需要把周期压到毫秒级时才提供。
 */
export const LEASE_SWEEP_OPTIONS = 'ATB_LEASE_SWEEP_OPTIONS';

export interface LeaseSweepOptions {
  /** 后台回收扫描的周期（毫秒）。 */
  intervalMs?: number;
}

export type LeaseVerdict =
  | { kind: 'ok'; task: Task; run: TaskRun; agent: AgentAuth }
  | { kind: 'replay'; task: Task; run: TaskRun }
  | { kind: 'orphan'; task: Task; run: TaskRun; agent: AgentAuth };

@Injectable()
export class LeaseService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger('lease');
  private timer: NodeJS.Timeout | null = null;
  private readonly intervalMs: number;
  private sweeping = false;

  constructor(
    private readonly prisma: PrismaService,
    private readonly settings: SettingsService,
    private readonly audit: AuditService,
    private readonly events: EventsService,
    private readonly notifications: NotificationsService,
    @Optional() @Inject(LEASE_SWEEP_OPTIONS) options?: LeaseSweepOptions,
  ) {
    this.intervalMs = options?.intervalMs ?? LEASE_SWEEP_INTERVAL_MS;
  }

  /** 定时器此刻是否在跑：装配用例据此判断 onModuleInit / onModuleDestroy 有没有接上。 */
  get sweeperRunning(): boolean {
    return this.timer !== null;
  }

  /** 本次生效的扫描周期；不注入 options 时恒等于 4.3.2 的 30 秒。 */
  get sweeperIntervalMs(): number {
    return this.intervalMs;
  }

  onModuleInit(): void {
    this.startSweeper();
  }

  onModuleDestroy(): void {
    this.stopSweeper();
  }

  startSweeper(): void {
    if (this.timer) return;
    this.timer = setInterval(() => {
      this.reclaimExpired().catch((error: unknown) => {
        this.logger.warn(`租约回收扫描失败：${(error as Error)?.message ?? String(error)}`);
      });
    }, this.intervalMs);
    // 定时器不能拖住进程退出：sidecar 优雅停机与 vitest 收尾都依赖这一点。
    this.timer.unref?.();
  }

  stopSweeper(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  ttlModifier(ttlMinutes: number): string {
    return `+${ttlMinutes} minutes`;
  }

  /** 4.3.2 校验链的最后一步：有效租约 = 未过期且未吊销。 */
  isLeaseLive(task: Pick<Task, 'leaseRevokedAt' | 'leaseExpiresAt'>): boolean {
    if (task.leaseRevokedAt) return false;
    if (!task.leaseExpiresAt) return false;
    return task.leaseExpiresAt > nowSql();
  }

  /**
   * 所有写回入口共用的校验链（4.3.2）：
   * token 有效 → task 存在 → run 存在且属于该 task → run.lease_id == 入参 lease_id
   * → 入参 lease_id == task.lease_id（当前持有）→ lease_revoked_at IS NULL → lease_expires_at > now。
   * 顺序即错误语义：吊销优先于过期，过期优先于孤儿。
   */
  async verify(input: LeaseTriple, auth: RequestAuth, allowReplay = false): Promise<LeaseVerdict> {
    const agent = agentOf(auth);
    const context = { task_id: input.task_id, run_id: input.run_id };

    const task = await this.prisma.task.findUnique({ where: { id: input.task_id } });
    if (!task || task.accountId !== agent.accountId) {
      // Run 随任务级联消失，Agent 手里的三元组已无从校验，只能按「任务没了」回。
      // 账号不匹配同样按「任务没了」回：跨账号的三元组不提示存在性（20.5 口径）。
      throw new ApiException('TASK_GONE', '任务已删除，结果未写入', undefined, context);
    }

    const run = await this.prisma.taskRun.findUnique({ where: { id: input.run_id } });
    if (!run || run.taskId !== task.id) {
      throw new ApiException(
        'LEASE_EXPIRED',
        'run_id 不属于该任务的执行记录，结果未写入',
        undefined,
        context,
      );
    }
    // 4.3.2 表第 7 行：租约已随完成清空，但 run_id 仍属该任务且任务停在 REVIEW → 网络重试，幂等成功。
    if (allowReplay && task.status === 'REVIEW' && task.currentRunId === run.id) {
      return { kind: 'replay', task, run };
    }
    if (run.leaseId !== input.lease_id) {
      // 任务被重新认领后，旧 Run 的 lease 再也换不回写入权。
      throw new ApiException('LEASE_EXPIRED', USER_COPY.leaseExpired, undefined, context);
    }
    if (task.leaseId !== input.lease_id) {
      // 过期回收 + 重新认领后，旧三元组在 Run 上仍对得上，但任务当前持有的是新租约；
      // 只比 Run 的话，旧 Agent 会带着新租约的有效期把任务推向待审核（4.4 的唯一持有者）。
      throw new ApiException('LEASE_EXPIRED', USER_COPY.leaseExpired, undefined, context);
    }
    if (task.leaseRevokedAt) {
      // 4.3.1 规则 2：停止只吊销租约，任务状态与 stop_reason 保持强制停止时写入的值。
      throw new ApiException('LEASE_REVOKED', USER_COPY.leaseRevoked, undefined, context);
    }
    if (!this.isLeaseLive(task)) {
      if (task.status === 'RUNNING') {
        // 表第 3 行：过期但还没被扫描回收时，在同一判定里先回收再回 410，
        // 不留「过期租约仍可完成」的窗口。
        await this.reclaim(task, run, 'lease expired');
      }
      throw new ApiException('LEASE_EXPIRED', USER_COPY.leaseExpired, undefined, context);
    }
    if (task.status !== 'RUNNING') {
      await this.markAbandoned(run, task.status);
      return { kind: 'orphan', task, run, agent };
    }

    return { kind: 'ok', task, run, agent };
  }

  async heartbeat(input: LeaseTriple, auth: RequestAuth) {
    const verdict = await this.verify(input, auth);
    const ttl = await this.settings.get('lease_ttl_minutes');
    const interval = await this.settings.get('heartbeat_interval_seconds');

    await this.prisma.$executeRawUnsafe(
      `UPDATE tasks SET lease_expires_at = datetime('now', ?), updated_at = datetime('now')
       WHERE id = ? AND status = 'RUNNING' AND lease_id = ?`,
      this.ttlModifier(ttl),
      input.task_id,
      input.lease_id,
    );
    const rows = await this.prisma.$queryRawUnsafe<{ lease_expires_at: string | null }[]>(
      `SELECT lease_expires_at FROM tasks WHERE id = ?`,
      input.task_id,
    );

    return {
      task_id: verdict.task.id,
      run_id: verdict.run.id,
      lease_id: verdict.run.leaseId,
      expires_at: toIso(rows[0]?.lease_expires_at ?? null),
      ttl_minutes: ttl,
      heartbeat_interval_seconds: interval,
    };
  }

  /** 定时器入口：扫 `status='RUNNING' AND lease_expires_at <= now`，逐个在同一事务内回收。 */
  async reclaimExpired(): Promise<string[]> {
    if (this.sweeping) return [];
    this.sweeping = true;
    try {
      const expired = await this.prisma.$queryRaw<{ id: string }[]>`
        SELECT t.id FROM tasks t
        WHERE t.status = 'RUNNING'
          AND (t.lease_expires_at IS NULL OR t.lease_expires_at <= datetime('now'))
        ORDER BY t.lease_expires_at ASC
        LIMIT 100`;
      const reclaimed: string[] = [];
      for (const { id } of expired) {
        // 时间判定留在 SQL 里（`datetime('now')` 与租约写入用的是同一个时钟），
        // 但行本身要用 Prisma 重读：裸 $queryRaw 返回的是列名（lease_id / current_run_id），
        // 直接当 Task 用会让下面两个 camelCase 字段读成 undefined，回收只改任务不改 Run。
        const task = await this.prisma.task.findUnique({ where: { id } });
        if (!task || task.status !== 'RUNNING') continue;
        // lease_expires_at 为空的 RUNNING 只可能来自异常写入，一并回收，否则它永远留在执行中列。
        const run = task.currentRunId
          ? await this.prisma.taskRun.findUnique({ where: { id: task.currentRunId } })
          : null;
        const done = await this.reclaim(task, run, 'lease expired');
        if (done) reclaimed.push(task.id);
      }
      return reclaimed;
    } finally {
      this.sweeping = false;
    }
  }

  /**
   * 9.3 租约过期回收：任务置 FAILED + stop_reason='lease_expired'、清 lease_id/current_run_id，
   * 对应 Run 置 FAILED 并写 error='lease expired' 与 finished_at，全部同事务。
   * 事件与通知在事务提交后发——回滚时不该让看板看见一次没发生的回收。
   */
  private async reclaim(task: Task, run: TaskRun | null, error: string): Promise<boolean> {
    const now = nowSql();
    const runId = run?.id ?? task.currentRunId;
    const done = await this.prisma.$transaction(async (tx) => {
      const changed = await tx.$executeRawUnsafe(
        `UPDATE tasks SET status = 'FAILED', stop_reason = 'lease_expired',
                lease_id = NULL, lease_expires_at = NULL, current_run_id = NULL, updated_at = ?
         WHERE id = ? AND status = 'RUNNING'`,
        now,
        task.id,
      );
      if (changed === 0) return false;
      if (runId) {
        await tx.taskRun.updateMany({
          where: { id: runId, status: 'RUNNING' },
          data: { status: 'FAILED', finishedAt: now, error, durationMs: durationOf(run, now) },
        });
      }
      await tx.comment.create({
        data: {
          id: newId(),
          taskId: task.id,
          runId,
          authorType: 'system',
          type: 'status_change',
          content: '租约超时未续期，任务转为异常/失败',
        },
      });
      await this.audit.record(
        {
          actorType: 'system',
          action: 'lease_expire',
          targetType: 'task',
          targetId: task.id,
          before: { status: 'RUNNING', lease_id: task.leaseId, run_id: runId },
          after: { status: 'FAILED', stop_reason: 'lease_expired' },
        },
        tx,
      );
      return true;
    });

    if (!done) return false;
    this.events.emit('lease.expired', { task_id: task.id, run_id: runId });
    this.events.emit('task.moved', { id: task.id, from: 'RUNNING', to: 'FAILED' });
    this.events.emit('task.updated', { id: task.id });
    await this.notifications.push(
      'lease_expired',
      task.id,
      `任务 ${task.id} 租约超时未续期，已转为异常/失败`,
    );
    return true;
  }

  /** 9.3 孤儿回写：租约对得上但状态已非 RUNNING，Run 置 ABANDONED，任务状态不回滚（人的操作优先）。 */
  private async markAbandoned(run: TaskRun, status: string): Promise<void> {
    if (run.status !== 'RUNNING') return;
    const now = nowSql();
    await this.prisma.taskRun.updateMany({
      where: { id: run.id, status: 'RUNNING' },
      data: {
        status: 'ABANDONED',
        finishedAt: now,
        durationMs: durationOf(run, now),
        error: `回写时任务已不在执行中（当前 ${status}），结果按孤儿回写归档`,
      },
    });
    this.logger.log(`孤儿回写：Run ${run.id} 置 ABANDONED（任务 ${run.taskId} 现为 ${status}）`);
  }
}

/** `duration_ms` 在 Run 收尾处算好，13 章的执行记录列表直接读列。 */
function durationOf(run: TaskRun | null, now: string): number | null {
  if (!run) return null;
  return durationMs(run.startedAt, now);
}
