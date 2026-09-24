import { Injectable } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import { ApiException } from '../contract/errors';
import {
  LOG_LINES_HEAD,
  LOG_LINES_MAX,
  LOG_LINES_TAIL,
  STATUS_LABEL,
  type TaskStatus,
} from '../contract/enums';
import { durationMs, nowSql } from '../contract/time';
import { newId } from '../contract/ids';
import { parseJsonObject } from '../tasks/task.dto';
import type { TaskDetailDto } from '../tasks/task.dto';
import { TasksService } from '../tasks/tasks.service';
import { taskPatchFromUpdateInput } from '../contract/agent-schemas';
import type { RequestAuth } from '../auth/auth.scope';
import { AuditService } from '../infra/audit.service';
import { EventsService } from '../infra/events.service';
import { NotificationsService } from '../infra/notifications.service';
import { PrismaService } from '../infra/prisma.service';
import { agentOf } from './agent-auth';
import { AgentQueryService } from './agent-query.service';
import type {
  AppendLogInput,
  BlockedInput,
  CompleteInput,
  FailInput,
  ProgressInput,
  UpdateTaskInput,
  WaitResumeInput,
} from './agent-inputs';
import type { LeaseVerdict } from './lease.service';
import { LeaseService } from './lease.service';

/**
 * `update_task` 拒绝时的出口指引（三支裁定的第三支）：状态本身不可编辑，
 * 但每个状态都有它自己的那条链路——错误里直接指名，Agent 一次改对而不是试错。
 */
const NOT_EDITABLE_ROUTE: Partial<Record<TaskStatus, { route: string; via: string }>> = {
  BLOCKED: {
    route: 'manual_resume',
    via: '人工处理后由 UI 把任务转回「待执行」（READY）或需求池，再 claim_next_task 拿新三元组（block_task 已把租约清空，本任务不存在可用租约）；等待解除可用 wait_for_resume',
  },
  REVIEW: {
    route: 'review_form',
    via: '走审核链路：只能由人在 UI 提交审核结论（通过=已完成 / 驳回=退回 READY 或 BACKLOG），驳回后重新认领才可编辑；先看意见用 get_review_feedback',
  },
  DONE: {
    route: 'new_task',
    via: '已完成是终态（4.5 状态机没有出边），不可编辑；需要返工请在 UI 新建后续任务，再走拆解/认领流程',
  },
  FAILED: {
    route: 'reopen_and_reclaim',
    via: '请先由人在 UI 把它转回「待执行」（READY）或需求池，再 claim_next_task 建新 Run 与新租约；持新租约后就能用本工具改字段',
  },
};

@Injectable()
export class WritebackService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly leases: LeaseService,
    private readonly audit: AuditService,
    private readonly events: EventsService,
    private readonly notifications: NotificationsService,
    private readonly query: AgentQueryService,
    /** §16.1 `update_task`：字段级校验与落库复用 TasksService 那一份 patch 实现（不写第二套）。 */
    private readonly tasks: TasksService,
  ) {}

  /**
   * §16.1 `update_task`：Agent 面的全字段 PATCH。本方法只做**写权限守卫**，
   * 字段校验（type 词表 + 可接受值回显、priority 0-3、tags、skills 归属/版本、
   * parent 层级 ≤2、group 存在、custom_fields）与审计/事件全在 `TasksService` 那一份里。
   *
   * 三支裁定：
   *  1. `RUNNING`：必须带**该任务当前**的租约三元组，口径与 `update_progress` 完全一致
   *     （`leases.verify`：过期/吊销/不属本 Token/不是当前持有者一律沿用既有 410 语义）。
   *     校验通过才放行，并且走 `patchAsAgent` 绕过 REST 那句「执行中不可编辑」——
   *     8.1 那条守卫防的是 UI 侧与人抢改，当前持有者是唯一写入方，不存在这个冲突；
   *     UI 的行为一字不动，故 REST 入口仍走 `patch()`。
   *  2. `BACKLOG` / `READY`：免租约可改（拆解/建单 Agent 修正自己产出的子任务的标题、
   *     优先级、标签、技能绑定）——这两个状态还没被认领，没有租约可带。
   *  3. 其余（`BLOCKED` / `REVIEW` / `DONE` / `FAILED`，含表外状态）：拒 409
   *     `TASK_NOT_EDITABLE`，message 与 details 指名该走的链路。
   *
   * 越权面：`status` / `assignee` 都不在 `updateTaskSchema` 的可写键里——MCP 协议层会先按
   * inputSchema 把未声明的键剥掉（非 HTTP 直连通道则由 `.strict()` 报 422
   * `unrecognized_keys`），本工具改不到状态机与执行权。
   */
  async updateTask(input: UpdateTaskInput, auth: RequestAuth): Promise<TaskDetailDto> {
    const agent = agentOf(auth);
    const task = await this.prisma.task.findUnique({ where: { id: input.task_id } });
    if (!task) {
      throw new ApiException('NOT_FOUND', '任务不存在', undefined, { task_id: input.task_id });
    }
    const patch = taskPatchFromUpdateInput(input);

    if (task.status === 'RUNNING') {
      if (!input.run_id || !input.lease_id) {
        throw new ApiException(
          'VALIDATION_FAILED',
          `任务 ${task.id} 正在执行中，改字段必须带当前租约三元组：run_id + lease_id（来自 claim_next_task 的 lease 对象；本任务当前 run 是 ${task.currentRunId ?? '未知'}）。未认领的任务（BACKLOG/READY）才免租约可改`,
          [
            { path: 'run_id', code: 'required_when_running', message: 'claim_next_task 返回的 lease.run_id' },
            { path: 'lease_id', code: 'required_when_running', message: 'claim_next_task 返回的 lease.lease_id' },
          ],
          { task_id: task.id, status: task.status, current_run_id: task.currentRunId },
        );
      }
      const verdict = await this.leases.verify(
        { task_id: input.task_id, run_id: input.run_id, lease_id: input.lease_id },
        auth,
      );
      if (verdict.kind !== 'ok') {
        // verify 对非 RUNNING 任务按孤儿回写处理（Run 置 ABANDONED）；这里没有可写的窗口。
        throw new ApiException(
          'TASK_NOT_RUNNING',
          `任务 ${task.id} 已不在执行中（当前「${STATUS_LABEL[verdict.task.status as TaskStatus] ?? verdict.task.status}」），无法按租约编辑`,
          undefined,
          { task_id: task.id, run_id: verdict.run.id, status: verdict.task.status },
        );
      }
      return this.tasks.patchAsAgent(task.id, patch, agent.tokenName);
    }

    if (task.status !== 'BACKLOG' && task.status !== 'READY') {
      const label = STATUS_LABEL[task.status as TaskStatus] ?? task.status;
      const guide = NOT_EDITABLE_ROUTE[task.status as TaskStatus] ?? {
        route: 'manual',
        via: `状态「${task.status}」不在可编辑窗口内：可编辑的只有 BACKLOG/READY（免租约）与 RUNNING（持当前租约）`,
      };
      throw new ApiException(
        'TASK_NOT_EDITABLE',
        `任务 ${task.id} 处于「${label}」，不可编辑。该走这条路：${guide.via}`,
        [
          {
            path: 'status',
            code: 'not_editable',
            message: `当前「${label}」不可编辑；可编辑：BACKLOG/READY（免租约）、RUNNING（须持当前 run_id + lease_id）。下一步：${guide.via}`,
          },
        ],
        { task_id: task.id, status: task.status, route: guide.route },
      );
    }

    return this.tasks.patchAsAgent(task.id, patch, agent.tokenName);
  }

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

    await this.assertUploadedArtifacts(verdict.task.id, input.artifacts);
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
   * 8.4 人工块：Agent 执行到人工块时上报，任务转 BLOCKED 等人工处理。
   * Run 置 FAILED 收口（否则任务回 READY 重新认领后它会永远挂在 RUNNING，占住
   * 「单任务一个活动 Run」的部分唯一索引），error 记人工块指令；租约随转 BLOCKED 清空，
   * 人工处理完成、BLOCKED→READY 之后由新的认领产生新租约。
   * 租约已清空，重试的旧三元组与 complete/fail 一样回 410（不做幂等回放）。
   */
  async blocked(input: BlockedInput, auth: RequestAuth) {
    const verdict = await this.leases.verify(input, auth);
    if (verdict.kind !== 'ok') {
      // verify 对非 RUNNING 任务按孤儿回写处理（Run 置 ABANDONED）；这里没有可写的状态。
      throw new ApiException('TASK_NOT_RUNNING', '任务不在执行中，无法转人工阻塞');
    }
    const agent = agentOf(auth);
    const now = nowSql();
    const instruction = input.instruction;
    const title = input.block_title || input.block_id;

    await this.prisma.$transaction(async (tx) => {
      await tx.taskRun.update({
        where: { id: verdict.run.id },
        data: {
          status: 'FAILED' as const,
          error: `人工块「${title}」等待人工处理：${instruction}`,
          finishedAt: now,
          durationMs: durationMs(verdict.run.startedAt, now),
        },
      });
      await tx.task.update({
        where: { id: verdict.task.id },
        data: {
          status: 'BLOCKED',
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
          content: `Agent 执行到人工块「${title}」，任务转人工阻塞：${instruction.slice(0, 120)}`,
        },
      });
      await tx.comment.create({
        data: {
          id: newId(),
          taskId: verdict.task.id,
          runId: verdict.run.id,
          authorType: 'agent',
          authorName: agent.tokenName,
          type: 'log',
          content: instruction,
        },
      });
      await this.audit.record(
        {
          actorType: 'agent',
          actorName: agent.tokenName,
          action: 'run_writeback',
          targetType: 'run',
          targetId: verdict.run.id,
          before: { status: 'RUNNING', task_status: verdict.task.status },
          after: { status: 'FAILED', task_status: 'BLOCKED', blocked_by: input.block_id },
        },
        tx,
      );
    });

    this.events.emit('task.moved', { id: verdict.task.id, from: 'RUNNING', to: 'BLOCKED' });
    this.events.emit('task.updated', { id: verdict.task.id });

    return {
      task_id: verdict.task.id,
      run_id: verdict.run.id,
      task_status: 'BLOCKED' as TaskStatus,
      idempotent: false,
      orphaned: false,
    };
  }

  /**
   * v0.0.4 W6 §16.1 `wait_for_resume`：只读的长轮询，等任务离开 BLOCKED。
   * 语义：`block_task` 之后 Agent 侧不结束循环——挂在这一个 tools/call 上，直到人工
   * 在 UI 上把 BLOCKED 转回 READY / BACKLOG（`tasks.service.transition` 会 emit
   * `task.moved`，本方法按 `from='BLOCKED'` 命中），或到达 `timeout_seconds`。
   * 无三元组：block 已清空租约，等待方只读事件不改写库；恢复后 Agent 走新一次
   * `claim_next_task` 拿新租约，与 complete/fail 的回执通道不重叠。
   */
  async waitResume(input: WaitResumeInput, auth: RequestAuth) {
    agentOf(auth);
    const task = await this.prisma.task.findUnique({ where: { id: input.task_id } });
    if (!task) throw new ApiException('TASK_GONE', '任务不存在', undefined, { task_id: input.task_id });
    if (task.status !== 'BLOCKED') {
      // 未处于 BLOCKED（READY/RUNNING/REVIEW/DONE/FAILED/BACKLOG）时立即回，避免白占一条长连接。
      return {
        task_id: task.id,
        status: task.status as TaskStatus,
        resumed: false,
        timed_out: false,
        waited_seconds: 0,
      };
    }
    const started = Date.now();
    const outcome = await this.awaitBlockedExit(task.id, input.timeout_seconds);
    const latest = await this.prisma.task.findUnique({ where: { id: input.task_id } });
    const waitedSeconds = Math.round((Date.now() - started) / 100) / 10;
    const stillBlocked = (latest?.status ?? 'BLOCKED') === 'BLOCKED';
    return {
      task_id: input.task_id,
      status: (latest?.status ?? 'BLOCKED') as TaskStatus,
      resumed: outcome === 'moved' && !stillBlocked,
      timed_out: outcome === 'timeout' && stillBlocked,
      waited_seconds: waitedSeconds,
    };
  }

  /** 长轮询的内部实现：sink + 定时器二选一落地，两者都需在返回前回收。 */
  private awaitBlockedExit(taskId: string, timeoutSeconds: number): Promise<'moved' | 'timeout'> {
    return new Promise((resolve) => {
      let settled = false;
      const finish = (value: 'moved' | 'timeout') => {
        if (settled) return;
        settled = true;
        off();
        clearTimeout(timer);
        resolve(value);
      };
      const off = this.events.registerSink((event) => {
        if (event.event !== 'task.moved') return;
        if (event.data.id !== taskId) return;
        if (event.data.from !== 'BLOCKED') return;
        finish('moved');
      });
      const timer = setTimeout(() => finish('timeout'), timeoutSeconds * 1000);
      // 定时器不能拖住进程退出（vitest 收尾与优雅停机依赖这一点，与 LeaseService 扫描同口径）。
      timer.unref?.();
    });
  }

  /**
   * 20.6：除 `link` 外的产物必须先经 `POST /api/v1/artifacts` 落盘，`complete_task` 只引用其 uri。
   * 先校验再写，避免任务已经转 REVIEW 才发现产物不合法。
   * B8s（beta.6）：按**任务**而不是按 run 查已上传行——租约回收后重领的 agent 引用的
   * 可能是旧 run 已落盘的 uri（uri 本身含 run 段，不会跨任务串），拒了就没有补救路径。
   */
  private async assertUploadedArtifacts(taskId: string, artifacts: CompleteInput['artifacts']) {
    const uploaded = await this.prisma.artifact.findMany({
      where: { taskId },
      select: { uri: true },
    });
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
      // B8s：与 assertUploadedArtifacts 同口径按任务查——引用的 uri 可能挂在旧 run 行上。
      const row = await tx.artifact.findFirst({ where: { taskId: verdict.task.id, uri: item.uri } });
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
