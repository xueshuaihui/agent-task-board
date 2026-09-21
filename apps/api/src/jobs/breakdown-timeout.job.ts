import { Injectable, type OnApplicationBootstrap, type OnModuleDestroy } from '@nestjs/common';
import { nowSql } from '../contract/time';
import { AuditService } from '../infra/audit.service';
import { AppLogger } from '../infra/logger';
import { PrismaService } from '../infra/prisma.service';

/**
 * §7.7/§7.8 + 20.3-10 的超时刻度（PRD 原文数值）：
 * - receiving（接收中）Agent 断连 30 分钟 → interrupted；
 * - reviewing（待确认）用户 7 天未确认 → interrupted（20.3-10：到期草案可查不可确认）。
 * creating/completed/cancelled 不在超时图上（§7.7 状态机只有两条超时边）。
 */
export const BREAKDOWN_RECEIVING_TIMEOUT_MS = 30 * 60 * 1000;
export const BREAKDOWN_REVIEWING_TIMEOUT_MS = 7 * 24 * 3600 * 1000;

export interface BreakdownTimeoutOutcome {
  interrupted: { id: string; from: 'receiving' | 'reviewing'; reason: string }[];
}

interface StaleRow {
  id: string;
}

/**
 * W7 遗留 b2：拆解超时收敛定时任务（§7.7）。
 *
 * 不加列（迁移 0012 头注：超时中断由读侧/定时侧判定，§7.6 没有的列一律不加）——
 * receiving 的「最后活动」取 max(会话 created_at, 最新一条 breakdown_progress.created_at)；
 * 草案上报（report_task_draft）没有自带时间戳，不计入活动信号，与迁移口径一致。
 *
 * 幂等：候选 SQL 按状态过滤，UPDATE 再带 `AND status = ?` 二次守卫——与 cancel/confirm
 * 竞态时后到者 0 行命中、静默跳过；重复 tick 对已 interrupted 的会话是空操作。
 * WS：PRD §13 事件表拆解只有五条（started/progress/task_draft/finished/cancelled），
 * 没有 interrupted 事件，遵循「不私加事件」纪律（同 W8-a2 resolved 口径）——前端经
 * GET 重拉收敛显示；超时不可确认的兜底在 BreakdownService.confirm 内联动实现。
 */
@Injectable()
export class BreakdownTimeoutJob implements OnApplicationBootstrap, OnModuleDestroy {
  private timer: NodeJS.Timeout | null = null;
  private running = false;

  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly logger: AppLogger,
  ) {}

  /** 进程启动即挂载；sidecar 可能活不到超时粒度，先补跑一轮再进周期。 */
  onApplicationBootstrap(): void {
    this.schedule(15_000, 5 * 60 * 1000);
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

  /** 定时器是否已挂载（装配断言用）。 */
  scheduled(): boolean {
    return this.timer !== null;
  }

  /** 定时器入口：异常漏出去会变成 unhandledRejection，main.ts 会据此退出进程。 */
  private async tick(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      const outcome = await this.runOnce();
      if (outcome.interrupted.length > 0) {
        this.logger.log(
          `拆解超时收敛：中断 ${outcome.interrupted.map((item) => `${item.id}(${item.from})`).join('，')}`,
          'jobs',
        );
      }
    } catch (error) {
      this.logger.error(`拆解超时收敛本轮失败：${(error as Error).message}`, undefined, 'jobs');
    } finally {
      this.running = false;
    }
  }

  /** 导出来给测试注入时钟与手动触发；now 决定两条截止线，调用方自己保证不与定时器并发。 */
  async runOnce(now: Date = new Date()): Promise<BreakdownTimeoutOutcome> {
    const outcome: BreakdownTimeoutOutcome = { interrupted: [] };

    // 边 1：receiving 断连 30 分钟——最后活动 = max(created_at, 最新 progress)。
    const receivingCutoff = nowSql(new Date(now.getTime() - BREAKDOWN_RECEIVING_TIMEOUT_MS));
    const stalled = await this.prisma.$queryRawUnsafe<StaleRow[]>(
      `SELECT s.id FROM breakdown_sessions s
       LEFT JOIN (SELECT session_id, MAX(created_at) AS last_at FROM breakdown_progress GROUP BY session_id) p
         ON p.session_id = s.id
       WHERE s.status = 'receiving' AND COALESCE(p.last_at, s.created_at) < ${'?'}
       ORDER BY s.created_at ASC`,
      receivingCutoff,
    );
    for (const row of stalled) {
      await this.interrupt(row.id, 'receiving', 'Agent 断连超 30 分钟（§7.7/§7.8）', outcome);
    }

    // 边 2：reviewing 用户 7 天未确认（§7.7 + 20.3-10，到期草案可查不可确认）。
    const reviewingCutoff = nowSql(new Date(now.getTime() - BREAKDOWN_REVIEWING_TIMEOUT_MS));
    const unconfirmed = await this.prisma.$queryRawUnsafe<StaleRow[]>(
      `SELECT id FROM breakdown_sessions
       WHERE status = 'reviewing' AND COALESCE(finished_at, created_at) < ?
       ORDER BY created_at ASC`,
      reviewingCutoff,
    );
    for (const row of unconfirmed) {
      await this.interrupt(row.id, 'reviewing', '用户超 7 天未确认（20.3-10）', outcome);
    }
    return outcome;
  }

  /** 单条收敛：状态守卫 UPDATE，0 行命中（竞态窗口被 cancel/confirm 抢跑）即静默跳过——幂等支点。 */
  private async interrupt(
    id: string,
    from: 'receiving' | 'reviewing',
    reason: string,
    outcome: BreakdownTimeoutOutcome,
  ): Promise<void> {
    const swept = await this.prisma.$executeRawUnsafe(
      `UPDATE breakdown_sessions SET status = 'interrupted' WHERE id = ? AND status = ?`,
      id,
      from,
    );
    if (swept === 0) return;
    await this.audit.record({
      actorType: 'system',
      actorName: 'breakdown_timeout',
      action: 'breakdown_timeout',
      targetType: 'breakdown_session',
      targetId: id,
      before: { status: from },
      after: { status: 'interrupted', reason, trigger: 'breakdown_timeout_job' },
    });
    outcome.interrupted.push({ id, from, reason });
  }
}
