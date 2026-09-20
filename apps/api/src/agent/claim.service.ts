import { Injectable, Logger } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { ApiException } from '../contract/errors';
import type { ClaimReason } from '../contract/enums';
import { uuidv7, nextRunId } from '../contract/ids';
import { toIso } from '../contract/time';
import { parseJsonArray } from '../tasks/task.dto';
import type { RequestAuth } from '../auth/auth.scope';
import { AuditService } from '../infra/audit.service';
import { EventsService } from '../infra/events.service';
import { PrismaService } from '../infra/prisma.service';
import { SettingsService } from '../infra/settings.service';
import { agentOf, type AgentAuth } from './agent-auth';
import type { ClaimInput, ListReadyInput } from './agent-inputs';
import type { ClaimResult } from './agent-task.dto';
import { AgentQueryService } from './agent-query.service';
import {
  capabilitiesCovered,
  effectiveCapabilities,
  taskTypeAllowed,
} from './capability-match';
import { LeaseService } from './lease.service';

/** 9.3：候选窗口 50 条，与 board_column_limit 无关，只是防止把整张待执行表读进内存。 */
const CLAIM_CANDIDATE_WINDOW = 50;

/** 50 条窗口外的 READY 任务在能力过滤后可能一条不剩，`list` 用更宽的窗口保证「看得见 ≈ 领得到」。 */
const LIST_CANDIDATE_WINDOW = 200;

/** 未抢到任务时用它结束事务：Prisma 只在回调抛错时 ROLLBACK，而这条路径必须零持久写入。 */
class ClaimMiss extends Error {
  constructor(readonly reason: ClaimReason) {
    super(reason);
  }
}

interface CandidateRow {
  id: string;
  type: string;
  required_capabilities: string | null;
  run_count: number;
}

@Injectable()
export class ClaimService {
  private readonly logger = new Logger('claim');

  constructor(
    private readonly prisma: PrismaService,
    private readonly settings: SettingsService,
    private readonly leases: LeaseService,
    private readonly audit: AuditService,
    private readonly events: EventsService,
    private readonly query: AgentQueryService,
  ) {}

  /**
   * 9.3 认领：一次只有一个任务，租约与 Run 同事务落库。
   *
   * 为什么不用 `$executeRawUnsafe('BEGIN IMMEDIATE')`（9.3 的实现约束原文）：
   * Prisma 的裸 raw 不锁连接，`connection_limit=1` 下别的请求会在我们两次 await 之间
   * 把语句发到同一条连接上，落进本事务——实测未抢到时的 ROLLBACK 会把别人的写一起吞掉，
   * 对方已经收到成功响应，写入却凭空消失。
   * `$transaction` 整段独占该连接，且 Prisma 的 SQLite 连接器发起的就是 `BEGIN IMMEDIATE`
   *（引擎内含该语句；实测只做 SELECT 的事务也会让外部进程的写等到 busy_timeout），
   * 因此写锁在事务开始那一刻就已拿到，候选选取与占位之间不会有第二个写者插进来。
   */
  async claim(input: ClaimInput, auth: RequestAuth): Promise<ClaimResult> {
    const agent = agentOf(auth);
    const effective = new Set(effectiveCapabilities(input.capabilities, agent.capabilities));
    const ttl = await this.settings.get('lease_ttl_minutes');
    const modifier = this.leases.ttlModifier(ttl);
    // 9.3：lease_id 在事务开始前生成，tasks.lease_id 与 task_runs.lease_id 引用同一份值。
    const leaseId = uuidv7();

    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        return await this.claimOnce(input, agent, effective, leaseId, modifier, ttl);
      } catch (error) {
        if (error instanceof ClaimMiss) {
          return { task: null, reason: error.reason };
        }
        if (isRunConflict(error)) {
          // 兜底的部分唯一索引被命中：说明该任务已有进行中的 Run，换下一个候选重试一次。
          this.logger.warn(`uniq_active_run 命中，重试认领：${(error as Error).message}`);
          continue;
        }
        throw error;
      }
    }

    throw new ApiException(
      'TASK_RUNNING',
      '该任务已存在进行中的执行记录，认领被数据库拒绝',
      undefined,
      { lease_id: leaseId },
    );
  }

  private async claimOnce(
    input: ClaimInput,
    agent: AgentAuth,
    effective: Set<string>,
    leaseId: string,
    modifier: string,
    ttl: number,
  ): Promise<ClaimResult> {
    const tokenId = agent.tokenId;
    const tokenName = agent.tokenName;
    const claimed = await this.prisma.$transaction(async (tx) => {
      const candidates = await tx.$queryRawUnsafe<CandidateRow[]>(
        `${CANDIDATE_SELECT} LIMIT ?`,
        CLAIM_CANDIDATE_WINDOW,
      );
      const matched = candidates.filter(
        (row) =>
          capabilitiesCovered(parseJsonArray(row.required_capabilities), effective) &&
          taskTypeAllowed(row.type, input.task_types),
      );
      if (matched.length === 0) {
        // 依赖过滤后就没有候选 → 队列真的空；有候选但全被能力/类型挡掉 → all_blocked（20.5 不细分）。
        throw new ClaimMiss(candidates.length === 0 ? 'no_ready_task' : 'all_blocked');
      }

      for (const candidate of matched) {
        // run_id 同样在占位语句之前定下：tasks.current_run_id 与 task_runs.id 必须同值。
        const runId = await nextRunId(tx);
        const changed = await tx.$executeRawUnsafe(
          CLAIM_UPDATE_SQL,
          runId,
          leaseId,
          modifier,
          candidate.id,
          candidate.id,
        );
        if (changed === 0) continue;

        await tx.taskRun.create({
          data: {
            id: runId,
            taskId: candidate.id,
            tokenId,
            // 20.8：agent_name 是认领成功时服务端写入的 api_tokens.name 副本，Agent 无从自报。
            agentName: tokenName,
            runNumber: candidate.run_count + 1,
            status: 'RUNNING',
            triggerType: 'agent_poll',
            leaseId,
          },
        });
        await tx.$executeRawUnsafe(`UPDATE tasks SET run_count = run_count + 1 WHERE id = ?`, candidate.id);
        await this.audit.record(
          {
            actorType: 'agent',
            actorName: tokenName,
            action: 'run_claim',
            targetType: 'run',
            targetId: runId,
            after: {
              task_id: candidate.id,
              lease_id: leaseId,
              run_number: candidate.run_count + 1,
              ttl_minutes: ttl,
            },
          },
          tx,
        );

        const rows = await tx.$queryRawUnsafe<{ lease_expires_at: string | null }[]>(
          `SELECT lease_expires_at FROM tasks WHERE id = ?`,
          candidate.id,
        );
        return { taskId: candidate.id, runId, expiresAt: rows[0]?.lease_expires_at ?? null };
      }

      // 理论上不可达：写锁已在本事务持有，占位条件不会被别人抢先满足。
      throw new ClaimMiss('all_blocked');
    });

    const task = await this.query.payload(claimed.taskId);
    this.events.emit('task.moved', { id: claimed.taskId, from: 'READY', to: 'RUNNING' });
    this.events.emit('task.updated', { id: claimed.taskId });
    return {
      task,
      lease: {
        lease_id: leaseId,
        run_id: claimed.runId,
        expires_at: toIso(claimed.expiresAt),
        ttl_minutes: ttl,
      },
    };
  }

  /** 5.4 + 20.5：与认领共用同一套过滤，不匹配的任务对该 Token 不可见也不提示原因。 */
  async listReady(input: ListReadyInput, auth: RequestAuth) {
    const agent = agentOf(auth);
    const effective = new Set(effectiveCapabilities(input.capabilities, agent.capabilities));
    const rows = await this.prisma.$queryRawUnsafe<CandidateRow[]>(
      `${CANDIDATE_SELECT} LIMIT ?`,
      LIST_CANDIDATE_WINDOW,
    );
    const matched = rows
      .filter(
        (row) =>
          capabilitiesCovered(parseJsonArray(row.required_capabilities), effective) &&
          taskTypeAllowed(row.type, input.task_types),
      )
      .slice(0, input.limit);

    return {
      items: await Promise.all(matched.map((row) => this.query.summary(row.id))),
      count: matched.length,
      limit: input.limit,
    };
  }
}

/** 5.4 的阻塞过滤 + 5.6 的抓取顺序；能力子集留在 Node 侧（9.3）。 */
const CANDIDATE_SELECT = `
  SELECT t.id, t.type, t.required_capabilities, t.run_count
  FROM tasks t
  WHERE t.status = 'READY'
    AND t.archived_at IS NULL
    -- 0919：父任务（需求）不进 Agent 池，只以子任务被领取
    AND NOT EXISTS (SELECT 1 FROM tasks c WHERE c.parent_task_id = t.id)
    AND (t.lease_id IS NULL OR t.lease_expires_at <= datetime('now'))
    AND NOT EXISTS (
      SELECT 1 FROM task_dependencies d
      JOIN tasks dep ON dep.id = d.depends_on
      WHERE d.task_id = t.id AND d.type = 'blocks' AND dep.status != 'DONE'
    )
  ORDER BY t.pinned DESC, t.priority ASC, t.created_at ASC`;

/**
 * 外层必须重复同一组可领取条件（9.3），否则并发下会覆盖他人租约。
 * `lease_revoked_at = NULL`：被强制停止过的任务退回待执行后，若不清掉吊销标记，
 * 新认领的 Agent 会被 4.3.2 的吊销分支永久挡在门外。
 */
const CLAIM_UPDATE_SQL = `
  UPDATE tasks
  SET status = 'RUNNING',
      current_run_id = ?,
      lease_id = ?,
      lease_expires_at = datetime('now', ?),
      claimed_at = datetime('now'),
      updated_at = datetime('now'),
      stop_reason = NULL,
      lease_revoked_at = NULL
  WHERE id = ?
    AND status = 'READY'
    AND archived_at IS NULL
    AND (lease_id IS NULL OR lease_expires_at <= datetime('now'))
    AND NOT EXISTS (
      SELECT 1 FROM task_dependencies d
      JOIN tasks dep ON dep.id = d.depends_on
      WHERE d.task_id = ? AND d.type = 'blocks' AND dep.status != 'DONE'
    )`;

/** `uniq_active_run` 命中时 Prisma 可能报 P2002，也可能把 SQLite 原文包在 P2010 里。 */
function isRunConflict(error: unknown): boolean {
  if (error instanceof Prisma.PrismaClientKnownRequestError) {
    if (error.code === 'P2002') return true;
  }
  const message = (error as Error)?.message ?? '';
  return message.includes('uniq_active_run') || message.includes('UNIQUE constraint failed');
}
