import { Injectable } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import { ApiException } from '../contract/errors';
import {
  LOG_LINES_HEAD,
  LOG_LINES_MAX,
  LOG_LINES_TAIL,
  type TaskStatus,
} from '../contract/enums';
import { durationMs, nowSql } from '../contract/time';
import { newId } from '../contract/ids';
import { parseJsonObject } from '../tasks/task.dto';
import type { RequestAuth } from '../auth/auth.scope';
import { AuditService } from '../infra/audit.service';
import { EventsService } from '../infra/events.service';
import { NotificationsService } from '../infra/notifications.service';
import { PrismaService } from '../infra/prisma.service';
import { agentOf } from './agent-auth';
import { AgentQueryService } from './agent-query.service';
import type { AppendLogInput, CompleteInput, FailInput, ProgressInput } from './agent-inputs';
import type { LeaseVerdict } from './lease.service';
import { LeaseService } from './lease.service';

@Injectable()
export class WritebackService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly leases: LeaseService,
    private readonly audit: AuditService,
    private readonly events: EventsService,
    private readonly notifications: NotificationsService,
    private readonly query: AgentQueryService,
  ) {}

  async updateProgress(input: ProgressInput, auth: RequestAuth) {
    const verdict = await this.leases.verify(input, auth);
    await this.prisma.taskRun.update({
      where: { id: verdict.run.id },
      data: { progress: input.progress, progressMsg: input.message ?? null },
    });
    this.events.emit('run.progress', {
      task_id: verdict.task.id,
      run_id: verdict.run.id,
      progress: input.progress,
      message: input.message ?? null,
    });
    this.events.emit('task.updated', { id: verdict.task.id });
    return {
      task_id: verdict.task.id,
      run_id: verdict.run.id,
      progress: input.progress,
      message: input.message ?? null,
      orphaned: verdict.kind === 'orphan',
    };
  }

  /** 20.8：Agent 只能追加 `type='log'`，作者名固定取 api_tokens.name，不接受自报。 */
  async appendLog(input: AppendLogInput, auth: RequestAuth) {
    const verdict = await this.leases.verify(input, auth);
    const agent = agentOf(auth);
    const truncated = await this.prisma.$transaction(async (tx) => {
      for (const line of input.lines) {
        await tx.comment.create({
          data: {
            id: newId(),
            taskId: verdict.task.id,
            runId: verdict.run.id,
            authorType: 'agent',
            authorName: agent.tokenName,
            type: 'log',
            content: line,
          },
        });
      }
      return this.trimLogs(tx, verdict.task.id, verdict.run.id);
    });
    this.events.emit('run.log', {
      task_id: verdict.task.id,
      run_id: verdict.run.id,
      level: input.level,
      // 13 章的事件载荷是单条 message；批量行合并成一条，前端只拿它当失效信号。
      message: input.lines[0] ?? '',
    });
    return {
      task_id: verdict.task.id,
      run_id: verdict.run.id,
      accepted: input.lines.length,
      truncated,
      orphaned: verdict.kind === 'orphan',
    };
  }

  /**
   * 4.3.2 表：正常持有 → 200 转 REVIEW；重复回写 → 200 幂等（不新增 Run、不重复通知）；
   * 孤儿回写 → Run 已由校验链置 ABANDONED，产物与摘要仍入库，任务状态不回滚。
   */
  async complete(input: CompleteInput, auth: RequestAuth) {
    const verdict = await this.leases.verify(input, auth, true);
    if (verdict.kind === 'replay') {
      return {
        task: await this.query.payload(verdict.task.id),
        run_id: verdict.run.id,
        run_status: verdict.run.status,
        task_status: verdict.task.status as TaskStatus,
        idempotent: true,
        orphaned: false,
      };
    }

    await this.assertUploadedArtifacts(verdict.run.id, input.artifacts);
    const agent = agentOf(auth);
    const now = nowSql();
    const orphaned = verdict.kind === 'orphan';

    await this.prisma.$transaction(async (tx) => {
      await tx.taskRun.update({
        where: { id: verdict.run.id },
        data: {
          // ABANDONED 不能被回写成 SUCCESS：孤儿回写只补摘要与产物。
          ...(orphaned ? {} : { status: 'SUCCESS' as const }),
          summary: input.summary ?? null,
          output: input.output ?? null,
          finishedAt: now,
          durationMs: durationMs(verdict.run.startedAt, now),
        },
      });
      await this.persistArtifacts(tx, verdict, input);

      if (!orphaned) {
        await tx.task.update({
          where: { id: verdict.task.id },
          data: {
            status: 'REVIEW',
            // 4.3.2：租约随完成清空；current_run_id 保留，审核表单靠它定位被审的 Run。
            leaseId: null,
            leaseExpiresAt: null,
            updatedAt: now,
          },
        });
        await tx.comment.create({
          data: {
            id: newId(),
            taskId: verdict.task.id,
            runId: verdict.run.id,
            authorType: 'system',
            type: 'status_change',
            content: `Agent 已完成执行，进入待审核${input.summary ? `：${input.summary.slice(0, 60)}` : ''}`,
          },
        });
      }

      await this.audit.record(
        {
          actorType: 'agent',
          actorName: agent.tokenName,
          action: 'run_writeback',
          targetType: 'run',
          targetId: verdict.run.id,
          before: { status: 'RUNNING', task_status: verdict.task.status },
          after: {
            status: orphaned ? 'ABANDONED' : 'SUCCESS',
            task_status: orphaned ? verdict.task.status : 'REVIEW',
            artifacts: input.artifacts.length,
          },
        },
        tx,
      );
    });

    if (!orphaned) {
      await this.notifications.push(
        'review_pending',
        verdict.task.id,
        `任务 ${verdict.task.id} 已完成，等待审核`,
      );
      this.events.emit('task.moved', { id: verdict.task.id, from: 'RUNNING', to: 'REVIEW' });
    }
    this.events.emit('task.updated', { id: verdict.task.id });

    return {
      task: await this.query.payload(verdict.task.id),
      run_id: verdict.run.id,
      run_status: orphaned ? 'ABANDONED' : 'SUCCESS',
      // verdict.task 是回写前的快照：孤儿回写不回滚任务状态，正常回写则已转待审核。
      task_status: (orphaned ? verdict.task.status : 'REVIEW') as TaskStatus,
      idempotent: false,
      orphaned,
    };
  }

  async fail(input: FailInput, auth: RequestAuth) {
    const verdict = await this.leases.verify(input, auth);
    const agent = agentOf(auth);
    const now = nowSql();
    const orphaned = verdict.kind === 'orphan';

    await this.prisma.$transaction(async (tx) => {
      await tx.taskRun.update({
        where: { id: verdict.run.id },
        data: {
          ...(orphaned ? {} : { status: 'FAILED' as const }),
          error: input.error,
          summary: input.summary ?? null,
          finishedAt: now,
          durationMs: durationMs(verdict.run.startedAt, now),
        },
      });
      if (!orphaned) {
        await tx.task.update({
          where: { id: verdict.task.id },
          data: {
            status: 'FAILED',
            // 4.3.2：Agent 自报失败只写 agent_reported，不冒充 user_stop / lease_expired。
            stopReason: 'agent_reported',
            leaseId: null,
            leaseExpiresAt: null,
            currentRunId: null,
            updatedAt: now,
          },
        });
        await tx.comment.create({
          data: {
            id: newId(),
            taskId: verdict.task.id,
            runId: verdict.run.id,
            authorType: 'system',
            type: 'status_change',
            content: `Agent 上报失败：${input.error.slice(0, 120)}`,
          },
        });
      }
      await this.audit.record(
        {
          actorType: 'agent',
          actorName: agent.tokenName,
          action: 'run_writeback',
          targetType: 'run',
          targetId: verdict.run.id,
          before: { status: 'RUNNING', task_status: verdict.task.status },
          after: {
            status: orphaned ? 'ABANDONED' : 'FAILED',
            task_status: orphaned ? verdict.task.status : 'FAILED',
          },
        },
        tx,
      );
    });

    if (!orphaned) {
      await this.notifications.push(
        'run_failed',
        verdict.task.id,
        `任务 ${verdict.task.id} 执行失败：${input.error.slice(0, 80)}`,
      );
      this.events.emit('task.moved', { id: verdict.task.id, from: 'RUNNING', to: 'FAILED' });
    }
    this.events.emit('task.updated', { id: verdict.task.id });

    return {
      task_id: verdict.task.id,
      run_id: verdict.run.id,
      run_status: orphaned ? 'ABANDONED' : 'FAILED',
      task_status: (orphaned ? verdict.task.status : 'FAILED') as TaskStatus,
      orphaned,
    };
  }

  /**
   * 20.6：除 `link` 外的产物必须先经 `POST /api/v1/artifacts` 落盘，`complete_task` 只引用其 uri。
   * 先校验再写，避免任务已经转 REVIEW 才发现产物不合法。
   */
  private async assertUploadedArtifacts(runId: string, artifacts: CompleteInput['artifacts']) {
    const uploaded = await this.prisma.artifact.findMany({ where: { runId }, select: { uri: true } });
    const known = new Set(uploaded.map((row) => row.uri));
    const missing = artifacts
      .filter((item) => item.type !== 'link' && !known.has(item.uri))
      .map((item) => item.uri);
    if (missing.length > 0) {
      throw new ApiException(
        'VALIDATION_FAILED',
        `以下产物未经上传接口落盘，不能引用：${missing.join('、')}`,
        missing.map((uri) => ({ path: 'artifacts.uri', code: 'not_uploaded', message: uri })),
      );
    }
  }

  private async persistArtifacts(
    tx: Prisma.TransactionClient,
    verdict: LeaseVerdict,
    input: CompleteInput,
  ): Promise<void> {
    for (const item of input.artifacts) {
      if (item.type === 'link') {
        // 重复回写时按 uri 去重，否则每次重试都多一条外链产物。
        const existing = await tx.artifact.findFirst({
          where: { runId: verdict.run.id, uri: item.uri },
        });
        if (existing) {
          await tx.artifact.update({
            where: { id: existing.id },
            data: { metadata: JSON.stringify({ name: item.name }) },
          });
          continue;
        }
        await tx.artifact.create({
          data: {
            id: newId(),
            runId: verdict.run.id,
            taskId: verdict.task.id,
            type: 'link',
            uri: item.uri,
            // 20.7：link 没有文件名，显示名只能来自 Agent 给的 name。
            metadata: JSON.stringify({ name: item.name }),
          },
        });
        continue;
      }
      if (!item.name) continue;
      const row = await tx.artifact.findFirst({ where: { runId: verdict.run.id, uri: item.uri } });
      if (!row) continue;
      const metadata = parseJsonObject(row.metadata);
      if (metadata.name === item.name) continue;
      await tx.artifact.update({
        where: { id: row.id },
        data: { metadata: JSON.stringify({ ...metadata, name: item.name }) },
      });
    }
  }

  /**
   * 20.8：单 Run 日志上限 5000 行，超出保留首 1000 + 最近 4000 并在中间插一条系统截断行。
   * 尾部只留 3999 是给系统行腾位，让总数仍停在 5000。
   * 并列时间戳按 rowid（= 插入顺序）判定：一次调用可写 500 行，created_at 只到秒，
   * UUID v7 的随机尾部在同一毫秒内并不单调。
   */
  private async trimLogs(
    tx: Prisma.TransactionClient,
    taskId: string,
    runId: string,
  ): Promise<boolean> {
    const counted = await tx.$queryRawUnsafe<{ count: number | bigint }[]>(
      `SELECT COUNT(*) AS count FROM comments WHERE run_id = ? AND type = 'log'`,
      runId,
    );
    const total = Number(counted[0]?.count ?? 0);
    if (total <= LOG_LINES_MAX) return false;

    await tx.$executeRawUnsafe(
      `DELETE FROM comments WHERE run_id = ? AND type = 'log' AND id IN (
         SELECT id FROM (
           SELECT id,
                  ROW_NUMBER() OVER (ORDER BY created_at ASC, rowid ASC) AS head_n,
                  ROW_NUMBER() OVER (ORDER BY created_at DESC, rowid DESC) AS tail_n
           FROM comments WHERE run_id = ? AND type = 'log'
         ) WHERE head_n > ? AND tail_n > ?
       )`,
      runId,
      runId,
      LOG_LINES_HEAD,
      LOG_LINES_TAIL - 1,
    );
    const marker = await tx.comment.findFirst({
      where: { runId, type: 'log', content: TRUNCATION_MARKER },
      select: { id: true },
    });
    if (!marker) {
      await tx.comment.create({
        data: {
          id: newId(),
          taskId,
          runId,
          authorType: 'system',
          type: 'log',
          content: TRUNCATION_MARKER,
        },
      });
    }
    return true;
  }
}

const TRUNCATION_MARKER = `日志超过 ${LOG_LINES_MAX} 行，中间部分已截断（保留首 ${LOG_LINES_HEAD} 行与最近 ${LOG_LINES_TAIL - 1} 行）`;
