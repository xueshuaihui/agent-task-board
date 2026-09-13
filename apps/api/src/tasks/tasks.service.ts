import { Injectable } from '@nestjs/common';
import { Prisma, type Task } from '@prisma/client';
import { ApiException, USER_COPY } from '../contract/errors';
import { BOARD_COLUMNS, STATUS_LABEL, TAGS_MAX_PER_TASK, type TaskStatus } from '../contract/enums';
import {
  appliesToType,
  normalizeMultiSelect,
  validateFieldValue,
  type FieldDefLike,
} from '../contract/custom-fields';
import {
  classifyTransition,
  REVIEW_EXIT_TARGETS,
} from '../contract/transitions';
import { toDateOnly, nowSql, toIso } from '../contract/time';
import { newId, nextTaskId } from '../contract/ids';
import type {
  BoardQuery,
  CustomFieldFilter,
  ListQuery,
  ReviewInput,
  TaskCreateInput,
  TaskPatchInput,
} from '../contract/schemas';
import { jsonFilterParts } from './json-filters';
import type { RequestAuth } from '../auth/auth.scope';
import { AuditService } from '../infra/audit.service';
import { EventsService } from '../infra/events.service';
import { PrismaService } from '../infra/prisma.service';
import { SettingsService } from '../infra/settings.service';
import { NotificationsService } from '../infra/notifications.service';
import {
  deriveArtifactName,
  parseJsonArray,
  parseJsonObject,
  toCardDto,
  TASK_ROW_COLUMNS,
  toNumOrNull,
  type CardArtifact,
  type TaskCardDto,
  type TaskDetailDto,
  type TaskRow,
} from './task.dto';

interface BlockedRow {
  task_id: string;
  id: string;
  title: string;
}

interface ArtifactRow {
  task_id: string;
  id: string;
  type: string;
  uri: string;
  metadata: string | null;
}

/**
 * 任务列表页的返回体：卡片字段 + 最近一次 Run 的时长与开始时间（原型 3.8 的「时长」列在
 * RUNNING 时要显示已进行时间，只有 `duration_ms` 算不出来）+ `archived_at`（同一张表的徽标）。
 */
interface ListResult {
  items: (TaskCardDto & {
    duration_ms: number | null;
    started_at: string | null;
    archived_at: string | null;
  })[];
  total: number;
  page: number;
  page_size: number;
}

@Injectable()
export class TasksService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly settings: SettingsService,
    private readonly audit: AuditService,
    private readonly events: EventsService,
    private readonly notifications: NotificationsService,
  ) {}

  // ---------------------------------------------------------------- 写入

  async create(input: TaskCreateInput, auth: RequestAuth): Promise<TaskDetailDto> {
    const types = await this.settings.get('task_types');
    if (!types.includes(input.type)) {
      throw new ApiException('VALIDATION_FAILED', `任务类型「${input.type}」不在词表内`, [
        { path: 'type', code: 'unknown_type', message: `可选：${types.join(' / ')}` },
      ]);
    }
    // 6.9.2：必填的拦截点是「拖到待执行」，创建时只校验已提交值的类型与登记情况。
    const customFields = await this.normalizeCustomFields(input.type, input.custom_fields, false);

    const id = await this.prisma.$transaction(async (tx) => {
      const taskId = await nextTaskId(tx);
      await tx.task.create({
        data: {
          id: taskId,
          type: input.type,
          title: input.title,
          description: input.description ?? null,
          status: 'BACKLOG',
          priority: input.priority,
          tags: JSON.stringify(input.tags),
          requiredCapabilities: JSON.stringify(input.required_capabilities),
          customFields: JSON.stringify(customFields),
          pinned: input.pinned ? 1 : 0,
          dueAt: input.due_at ? toDateOnly(input.due_at) : null,
        },
      });
      for (const dependsOn of [...new Set(input.depends_on)]) {
        await this.insertDependency(tx, taskId, dependsOn, input.dependency_type);
      }
      await this.audit.record(
        {
          actorType: auth.kind === 'ui' ? 'user' : 'agent',
          action: 'task_create',
          targetType: 'task',
          targetId: taskId,
          after: { id: taskId, type: input.type, title: input.title },
        },
        tx,
      );
      return taskId;
    });

    this.events.emit('task.created', { id });
    return this.getDetail(id);
  }

  async patch(id: string, input: TaskPatchInput): Promise<TaskDetailDto> {
    const before = await this.requireTask(id);
    if (before.status === 'RUNNING') {
      throw new ApiException('TASK_RUNNING', '执行中的任务不可编辑，请先强制停止');
    }

    const data: Prisma.TaskUpdateInput = { updatedAt: nowSql() };
    if (input.title !== undefined) data.title = input.title;
    if (input.description !== undefined) data.description = input.description;
    if (input.priority !== undefined) data.priority = Number(input.priority);
    if (input.pinned !== undefined) data.pinned = input.pinned ? 1 : 0;
    if (input.due_at !== undefined) data.dueAt = input.due_at ? toDateOnly(input.due_at) : null;
    if (input.tags !== undefined) data.tags = JSON.stringify(input.tags);
    if (input.required_capabilities !== undefined) {
      data.requiredCapabilities = JSON.stringify(input.required_capabilities);
    }

    const nextType = input.type ?? before.type;
    if (input.type !== undefined) {
      const types = await this.settings.get('task_types');
      if (!types.includes(input.type)) {
        throw new ApiException('VALIDATION_FAILED', `任务类型「${input.type}」不在词表内`, [
          { path: 'type', code: 'unknown_type', message: `可选：${types.join(' / ')}` },
        ]);
      }
      data.type = input.type;
    }
    if (input.custom_fields !== undefined) {
      const merged = {
        ...parseJsonObject(before.customFields),
        ...input.custom_fields,
      };
      data.customFields = JSON.stringify(
        await this.normalizeCustomFields(nextType, merged, false),
      );
    }

    await this.prisma.task.update({ where: { id }, data });
    await this.audit.record({
      actorType: 'user',
      action: 'task_update',
      targetType: 'task',
      targetId: id,
      before: pickAudit(before),
      after: { ...input },
    });
    this.events.emit('task.updated', { id });
    return this.getDetail(id);
  }

  async transition(
    id: string,
    to: TaskStatus,
    comment?: string,
  ): Promise<TaskCardDto> {
    const task = await this.requireTask(id);
    const from = task.status as TaskStatus;
    const verdict = classifyTransition(from, to);

    if (verdict.kind === 'forbidden') {
      throw new ApiException('ILLEGAL_TRANSITION', this.forbiddenMessage(verdict.reason, from, to));
    }
    if (verdict.kind === 'form') {
      // 4.5：`🔒` 目标必须先走各自的表单端点（审核 / 强制停止），transition 不代跑。
      throw new ApiException(
        'ILLEGAL_TRANSITION',
        verdict.form === 'stop' ? USER_COPY.dragToRunning : '该流转需要填写审核表单',
        undefined,
        { requires: verdict.form },
      );
    }

    if (to === 'READY') await this.assertRequiredFields(task);

    await this.setStatus(id, from, to, comment ?? defaultStatusCopy(from, to));
    const dto = await this.getCard(id);
    this.events.emit('task.moved', { id, from, to });
    this.events.emit('task.updated', { id });
    return dto;
  }

  /** 4.3.1 规则 2：强制停止 = 置 FAILED + 吊销租约，Agent 后续回写一律 410。 */
  async stop(id: string, reason: string | undefined): Promise<TaskCardDto> {
    const task = await this.requireTask(id);
    if (task.status !== 'RUNNING') {
      throw new ApiException('TASK_NOT_RUNNING', '任务不在执行中，无需停止');
    }
    const now = nowSql();
    await this.prisma.$transaction(async (tx) => {
      await tx.task.update({
        where: { id },
        data: {
          status: 'FAILED',
          stopReason: 'user_stop',
          leaseRevokedAt: now,
          leaseExpiresAt: task.leaseExpiresAt ?? now,
          currentRunId: null,
          updatedAt: now,
        },
      });
      if (task.currentRunId) {
        await tx.taskRun.updateMany({
          where: { id: task.currentRunId, status: 'RUNNING' },
          data: {
            status: 'FAILED',
            finishedAt: now,
            error: reason ? `用户强制停止：${reason}` : '用户强制停止',
          },
        });
      }
      await tx.comment.create({
        data: {
          id: newId(),
          taskId: id,
          runId: task.currentRunId,
          authorType: 'system',
          type: 'status_change',
          content: '已强制停止，转为异常/失败',
        },
      });
      await this.audit.record(
        {
          actorType: 'user',
          action: 'task_stop',
          targetType: 'task',
          targetId: id,
          before: { status: 'RUNNING', lease_id: task.leaseId },
          after: { status: 'FAILED', stop_reason: 'user_stop' },
        },
        tx,
      );
    });
    this.events.emit('task.moved', { id, from: 'RUNNING', to: 'FAILED' });
    this.events.emit('task.updated', { id });
    return this.getCard(id);
  }

  async submitReview(id: string, input: ReviewInput): Promise<TaskDetailDto> {
    const task = await this.requireTask(id);
    if (task.status !== 'REVIEW') {
      throw new ApiException('ILLEGAL_TRANSITION', '只有待审核的任务可以提交审核结论');
    }
    const runId = input.run_id ?? task.currentRunId;
    const approved = input.conclusion === 'APPROVE';
    const to: TaskStatus = approved ? 'DONE' : (input.return_to ?? 'READY');
    if (approved === false && !REVIEW_EXIT_TARGETS.includes(to)) {
      throw new ApiException('VALIDATION_FAILED', '退回目标只能是需求池或待执行');
    }
    const now = nowSql();

    await this.prisma.$transaction(async (tx) => {
      await tx.review.create({
        data: {
          id: newId(),
          taskId: id,
          runId,
          conclusion: input.conclusion,
          suggestion: input.suggestion,
          reason: input.reason,
          detail: input.detail,
          returnTo: approved ? null : to,
          priorityAdj: input.priority_adj === undefined ? null : Number(input.priority_adj),
        },
      });
      if (input.priority_adj !== undefined) {
        await tx.task.update({
          where: { id },
          data: { priority: Number(input.priority_adj), updatedAt: now },
        });
      }
      await tx.task.update({
        where: { id },
        data: {
          status: to,
          // 4.3.2：进入终态/退回时清空租约字段，lease_revoked_at 保留（若有）
          leaseId: null,
          leaseExpiresAt: null,
          currentRunId: null,
          updatedAt: now,
        },
      });
      if (runId) {
        await tx.taskRun.updateMany({
          where: { id: runId, status: 'SUCCESS' },
          data: { finishedAt: now, durationMs: null },
        });
      }
      await tx.comment.create({
        data: {
          id: newId(),
          taskId: id,
          runId,
          authorType: 'system',
          type: 'status_change',
          content: approved
            ? `审核通过，已完成（${input.suggestion.slice(0, 60)}）`
            : `驳回退回「${STATUS_LABEL[to]}」（${input.reason.slice(0, 60)}）`,
        },
      });
      await this.audit.record(
        {
          actorType: 'user',
          action: 'review_submit',
          targetType: 'review',
          targetId: id,
          before: { status: 'REVIEW' },
          after: { status: to, conclusion: input.conclusion },
        },
        tx,
      );
    });

    if (!approved) {
      await this.notifications.push('review_rejected', id, '你的任务被驳回，请查看审核意见');
    }
    if (approved) {
      await this.releaseDownstream(id);
    }
    this.events.emit('task.moved', { id, from: 'REVIEW', to });
    this.events.emit('task.updated', { id });
    return this.getDetail(id);
  }

  async addComment(
    id: string,
    content: string,
    runId: string | undefined,
    auth: RequestAuth,
  ): Promise<{ id: string }> {
    await this.requireTask(id);
    const commentId = newId();
    await this.prisma.comment.create({
      data: {
        id: commentId,
        taskId: id,
        runId: runId ?? null,
        authorType: 'user',
        // 20.8：单用户桌面，人一侧恒为「我」；Agent 侧的名称只能来自 api_tokens.name
        authorName: auth.kind === 'ui' ? '我' : auth.tokenName,
        type: 'comment',
        content,
      },
    });
    this.events.emit('task.updated', { id });
    return { id: commentId };
  }

  async setPinned(id: string, pinned: boolean): Promise<TaskCardDto> {
    const before = await this.requireTask(id);
    await this.prisma.task.update({
      where: { id },
      data: { pinned: pinned ? 1 : 0, updatedAt: nowSql() },
    });
    await this.audit.record({
      actorType: 'user',
      action: 'task_update',
      targetType: 'task',
      targetId: id,
      before: { pinned: before.pinned },
      after: { pinned },
    });
    this.events.emit('task.updated', { id });
    return this.getCard(id);
  }

  /** 4.3.1 规则 3 + 6.13：归档只允许 DONE，且不能仍是未完成任务的 blocks 前置。 */
  async archive(id: string): Promise<{ id: string; archived: boolean }> {
    const task = await this.requireTask(id);
    if (task.status !== 'DONE') {
      throw new ApiException('ILLEGAL_TRANSITION', '只有已完成的任务可以归档');
    }
    const blockers = await this.unfinishedDependents(id);
    if (blockers.length > 0) {
      throw new ApiException(
        'ARCHIVE_BLOCKED_BY_DEPENDENCY',
        USER_COPY.archiveBlocked(blockers.length),
        undefined,
        { downstream: blockers.map((row) => row.id) },
      );
    }
    await this.prisma.task.update({
      where: { id },
      data: { archivedAt: nowSql(), leaseId: null, leaseExpiresAt: null, updatedAt: nowSql() },
    });
    await this.audit.record({
      actorType: 'user',
      action: 'task_archive',
      targetType: 'task',
      targetId: id,
      after: { archived_at: nowSql() },
    });
    this.events.emit('task.archived', { task_id: id, archived: true });
    return { id, archived: true };
  }

  async restore(id: string): Promise<TaskCardDto> {
    await this.requireTask(id);
    await this.prisma.task.update({
      where: { id },
      data: { archivedAt: null, updatedAt: nowSql() },
    });
    await this.audit.record({
      actorType: 'user',
      action: 'task_archive',
      targetType: 'task',
      targetId: id,
      after: { archived_at: null },
    });
    this.events.emit('task.updated', { id });
    return this.getCard(id);
  }

  /** 4.3.1 规则 4：物理删除 + 级联产物文件；RUNNING 必须先强制停止。 */
  async remove(id: string): Promise<{
    id: string;
    deleted_runs: number;
    unblocked_ids: string[];
  }> {
    const task = await this.requireTask(id);
    if (task.status === 'RUNNING') {
      throw new ApiException('TASK_RUNNING', '执行中的任务不可删除，请先强制停止');
    }
    const runCount = await this.prisma.taskRun.count({ where: { taskId: id } });
    const artifactPaths = await this.prisma.artifact.findMany({
      where: { taskId: id, type: { not: 'link' } },
      select: { uri: true },
    });
    const dependents = await this.unfinishedDependents(id);

    await this.prisma.$transaction(async (tx) => {
      await tx.task.delete({ where: { id } });
      await this.audit.record(
        {
          actorType: 'user',
          action: 'task_delete',
          targetType: 'task',
          targetId: id,
          before: { status: task.status, runs: runCount },
        },
        tx,
      );
    });

    await this.deleteArtifactFiles(artifactPaths.map((row) => row.uri));
    const unblocked = await this.recomputeUnblocked(dependents);
    this.events.emit('task.deleted', { task_id: id, unblocked_ids: unblocked });
    return { id, deleted_runs: runCount, unblocked_ids: unblocked };
  }

  // ---------------------------------------------------------------- 依赖

  async addDependency(
    id: string,
    dependsOn: string,
    type: 'blocks' | 'relates',
  ): Promise<TaskDetailDto> {
    await this.requireTask(id);
    if (id === dependsOn) {
      throw new ApiException('DEPENDENCY_CYCLE', '任务不能依赖自身');
    }
    await this.prisma.$transaction(async (tx) => {
      await this.insertDependency(tx, id, dependsOn, type);
      await this.audit.record(
        {
          actorType: 'user',
          action: 'dep_add',
          targetType: 'dependency',
          targetId: id,
          after: { depends_on: dependsOn, type },
        },
        tx,
      );
    });
    this.events.emit('task.updated', { id });
    return this.getDetail(id);
  }

  async removeDependency(id: string, depId: string): Promise<TaskDetailDto> {
    const dep = await this.prisma.taskDependency.findFirst({ where: { id: depId, taskId: id } });
    if (!dep) throw new ApiException('NOT_FOUND', '依赖关系不存在');
    await this.prisma.$transaction(async (tx) => {
      await tx.taskDependency.delete({ where: { id: depId } });
      await this.audit.record(
        {
          actorType: 'user',
          action: 'dep_remove',
          targetType: 'dependency',
          targetId: id,
          before: { depends_on: dep.dependsOn, type: dep.type },
        },
        tx,
      );
    });
    this.events.emit('task.updated', { id });
    return this.getDetail(id);
  }

  /**
   * 添加依赖 = (task_id, depends_on) 的 upsert：已存在同边同类型直接返回，
   * 类型不同则改类型；改成 `blocks` 时才需要过环检测（20.2：relates 不参与）。
   */
  private async insertDependency(
    tx: Prisma.TransactionClient,
    taskId: string,
    dependsOn: string,
    type: 'blocks' | 'relates',
  ): Promise<void> {
    const existing = await tx.taskDependency.findUnique({
      where: { taskId_dependsOn: { taskId, dependsOn } },
    });
    const target = await tx.task.findUnique({ where: { id: dependsOn } });
    if (!target) {
      throw new ApiException('NOT_FOUND', `前置任务 ${dependsOn} 不存在`);
    }
    if (existing) {
      if (existing.type === type) return;
      if (type === 'blocks') await this.assertNoCycle(tx, taskId, dependsOn);
      await tx.taskDependency.update({ where: { id: existing.id }, data: { type } });
      return;
    }
    if (type === 'blocks') await this.assertNoCycle(tx, taskId, dependsOn);
    await tx.taskDependency.create({
      data: { id: newId(), taskId, dependsOn, type },
    });
  }

  /** 5.7：沿 blocks 边从前置出发能否回到本任务。UNION 去重保证有限步终止。 */
  private async assertNoCycle(
    tx: Prisma.TransactionClient,
    taskId: string,
    dependsOn: string,
  ): Promise<void> {
    const rows = await tx.$queryRawUnsafe<{ path: string }[]>(
      `WITH RECURSIVE walk(id, path) AS (
         SELECT ?, CAST(? AS TEXT)
         UNION
         SELECT d.depends_on, walk.path || ',' || d.depends_on
         FROM task_dependencies d JOIN walk ON d.task_id = walk.id
         WHERE d.type = 'blocks'
       )
       SELECT path FROM walk WHERE id = ? LIMIT 1`,
      dependsOn,
      dependsOn,
      taskId,
    );
    if (rows.length === 0) return;
    const chain = [...new Set(`${rows[0]!.path},${taskId}`.split(','))];
    const titles = await tx.task.findMany({
      where: { id: { in: chain } },
      select: { id: true, title: true },
    });
    const byId = new Map(titles.map((row) => [row.id, row.title]));
    const label = chain.map((id) => `${id} ${byId.get(id) ?? ''}`.trim()).join(' → ');
    throw new ApiException('DEPENDENCY_CYCLE', USER_COPY.dependencyCycle(label));
  }

  private async unfinishedDependents(id: string): Promise<{ id: string; title: string }[]> {
    return this.prisma.$queryRaw<{ id: string; title: string }[]>`
      SELECT t.id, t.title
      FROM task_dependencies d
      JOIN tasks t ON t.id = d.task_id
      WHERE d.depends_on = ${id} AND d.type = 'blocks' AND t.status != 'DONE' AND t.archived_at IS NULL`;
  }

  // ---------------------------------------------------------------- 批量

  async batchTransition(ids: string[], to: TaskStatus) {
    return this.batch(ids, (id) => this.transition(id, to).then(() => undefined));
  }

  async batchArchive(ids: string[]) {
    return this.batch(ids, (id) => this.archive(id).then(() => undefined));
  }

  async batchTags(ids: string[], add: string[], remove: string[]) {
    return this.batch(ids, async (id) => {
      const task = await this.requireTask(id);
      const current = new Set(parseJsonArray(task.tags));
      add.forEach((tag) => current.add(tag));
      remove.forEach((tag) => current.delete(tag));
      const next = [...current].slice(0, TAGS_MAX_PER_TASK);
      await this.prisma.task.update({
        where: { id },
        data: { tags: JSON.stringify(next), updatedAt: nowSql() },
      });
      this.events.emit('task.updated', { id });
    });
  }

  /** 逐条判定、不做整体回滚（6.13 / 13 章）：失败的任务连同原因进 skipped[]。 */
  private async batch(
    ids: string[],
    fn: (id: string) => Promise<void>,
  ): Promise<{ succeeded: string[]; skipped: { id: string; reason: string }[] }> {
    const succeeded: string[] = [];
    const skipped: { id: string; reason: string }[] = [];
    for (const id of [...new Set(ids)]) {
      try {
        await fn(id);
        succeeded.push(id);
      } catch (error) {
        if (error instanceof ApiException) {
          skipped.push({ id, reason: `${error.code}: ${error.message}` });
          continue;
        }
        skipped.push({ id, reason: `INTERNAL: ${(error as Error).message}` });
      }
    }
    return { succeeded, skipped };
  }

  // ---------------------------------------------------------------- 读取

  async getDetail(id: string): Promise<TaskDetailDto> {
    const row = await this.prisma.$queryRaw<TaskRow[]>`
      SELECT ${Prisma.raw(TASK_ROW_COLUMNS)}
      FROM tasks t LEFT JOIN task_runs r ON r.id = t.current_run_id
      WHERE t.id = ${id}`;
    if (row.length === 0) throw new ApiException('NOT_FOUND', '任务不存在');
    const card = await this.decorate([row[0]!]);
    const deps = await this.prisma.$queryRaw<
      { dir: string; dep_id: string; id: string; title: string; status: string; type: string }[]
    >`
      SELECT 'depends_on' AS dir, d.id AS dep_id, t.id, t.title, t.status, d.type
      FROM task_dependencies d JOIN tasks t ON t.id = d.depends_on WHERE d.task_id = ${id}
      UNION ALL
      SELECT 'blocks' AS dir, d.id AS dep_id, t.id, t.title, t.status, d.type
      FROM task_dependencies d JOIN tasks t ON t.id = d.task_id WHERE d.depends_on = ${id}`;

    const source = row[0]!;
    return {
      ...card[0],
      description: source.description,
      required_capabilities: parseJsonArray(source.required_capabilities),
      current_run_id: source.current_run_id,
      stop_reason: source.stop_reason,
      archived_at: toIso(source.archived_at),
      created_at: toIso(source.created_at),
      claimed_at: toIso(source.claimed_at),
      // 卡片只带 show_on_card 的字段，详情抽屉要看到全部值（20.10）。
      custom_fields: parseJsonObject(source.custom_fields),
      depends_on: deps
        .filter((dep) => dep.dir === 'depends_on')
        .map((dep) => ({
          id: dep.id,
          dep_id: dep.dep_id,
          title: dep.title,
          status: dep.status as TaskStatus,
          type: dep.type,
        })),
      blocks: deps
        .filter((dep) => dep.dir === 'blocks')
        .map((dep) => ({
          id: dep.id,
          dep_id: dep.dep_id,
          title: dep.title,
          status: dep.status as TaskStatus,
          type: dep.type,
        })),
    };
  }

  async board(query: BoardQuery): Promise<{
    generated_at: string;
    columns: { status: TaskStatus; label: string; count: number; has_more: boolean; tasks: TaskCardDto[] }[];
    unread_notifications: number;
  }> {
    const limit = await this.settings.get('board_column_limit');
    const scope = viewScope(query.view);
    const filters = await this.buildFilters(query);

    const counts = await this.prisma.$queryRaw<{ status: string; count: number }[]>`
      SELECT t.status, COUNT(*) AS count FROM tasks t
      WHERE t.archived_at IS NULL
        AND ${scope.statusIn}
        ${scope.blockedPredicate}
        ${filters.predicate}
      GROUP BY t.status`;
    const countBy = new Map(counts.map((row) => [row.status, Number(row.count)]));

    const columns = [];
    for (const status of BOARD_COLUMNS) {
      if (!scope.statuses.includes(status)) {
        columns.push({ status, label: STATUS_LABEL[status], count: 0, has_more: false, tasks: [] });
        continue;
      }
      const rows = await this.prisma.$queryRaw<TaskRow[]>`
        SELECT ${Prisma.raw(TASK_ROW_COLUMNS)}
        FROM tasks t LEFT JOIN task_runs r ON r.id = t.current_run_id
        WHERE t.archived_at IS NULL AND t.status = ${status}
          ${scope.blockedPredicate}
          ${filters.predicate}
        ORDER BY t.pinned DESC, t.priority ASC, t.created_at ASC
        LIMIT ${limit}`;
      const count = countBy.get(status) ?? rows.length;
      columns.push({
        status,
        label: STATUS_LABEL[status],
        count,
        has_more: count > limit,
        tasks: await this.decorate(rows),
      });
    }

    return {
      generated_at: new Date().toISOString(),
      columns,
      unread_notifications: await this.prisma.notification.count({ where: { readAt: null } }),
    };
  }

  async list(query: ListQuery): Promise<ListResult> {
    const where: Prisma.TaskWhereInput = {};
    if (query.archived === 'false') where.archivedAt = null;
    if (query.archived === 'true') where.archivedAt = { not: null };
    if (query.status?.length) where.status = { in: query.status };
    const priorities = (query.priority ?? []).map(Number).filter((value) => !Number.isNaN(value));
    if (priorities.length) where.priority = { in: priorities };
    if (query.type?.length) where.type = { in: query.type };
    if (query.keyword) {
      where.OR = [
        { title: { contains: query.keyword } },
        { description: { contains: query.keyword } },
        { id: { contains: query.keyword } },
      ];
    }
    const ids = await this.idsByJsonFilters(query.tags, query.custom_fields);
    if (ids) {
      where.id = ids.length ? { in: ids } : { in: ['__none__'] };
    }

    const total = await this.prisma.task.count({ where });
    const rows = await this.prisma.task.findMany({
      where,
      orderBy: listOrderBy(query.sort, query.order),
      skip: (query.page - 1) * query.page_size,
      take: query.page_size,
    });
    if (rows.length === 0) {
      return { items: [], total, page: query.page, page_size: query.page_size };
    }

    const withExtras = await this.prisma.$queryRaw<TaskRow[]>`
      SELECT ${Prisma.raw(TASK_ROW_COLUMNS)}
      FROM tasks t LEFT JOIN task_runs r ON r.id = t.current_run_id
      WHERE t.id IN (${Prisma.join(rows.map((row) => row.id))})`;
    const order = new Map(rows.map((row, index) => [row.id, index]));
    withExtras.sort((a, b) => (order.get(a.id) ?? 0) - (order.get(b.id) ?? 0));
    const cards = await this.decorate(withExtras);
    return {
      items: cards.map((card, index) => ({
        ...card,
        duration_ms: toNumOrNull(withExtras[index]?.last_run_duration_ms),
        started_at: toIso(withExtras[index]?.last_run_started_at),
        archived_at: toIso(withExtras[index]?.archived_at),
      })),
      total,
      page: query.page,
      page_size: query.page_size,
    };
  }

  /** 列表页先取候选 id，再和 Prisma 的其余条件求交；无 JSON 条件时返回 null 表示不过滤。 */
  private async idsByJsonFilters(
    tags: string[] | undefined,
    customFields: CustomFieldFilter | undefined,
  ): Promise<string[] | null> {
    const parts = jsonFilterParts(tags, customFields);
    if (parts.length === 0) return null;
    const rows = await this.prisma.$queryRaw<{ id: string }[]>`
      SELECT t.id FROM tasks t WHERE ${Prisma.join(parts, ' AND ')}`;
    return rows.map((row) => row.id);
  }

  async tags(): Promise<string[]> {
    const rows = await this.prisma.$queryRaw<{ tags: string | null }[]>`
      SELECT tags FROM tasks WHERE tags IS NOT NULL AND tags != '[]'`;
    const set = new Set<string>();
    for (const row of rows) parseJsonArray(row.tags).forEach((tag) => set.add(tag));
    return [...set].sort((a, b) => a.localeCompare(b, 'zh-CN'));
  }

  /** 详情抽屉各 Tab 的读取端点（13 章「读取模型」）。 */
  async runs(id: string) {
    await this.requireTask(id);
    const runs = await this.prisma.taskRun.findMany({
      where: { taskId: id },
      orderBy: { startedAt: 'desc' },
    });
    const artifacts = await this.prisma.artifact.findMany({
      where: { taskId: id },
      orderBy: { createdAt: 'desc' },
    });
    const reviews = await this.prisma.review.findMany({
      where: { taskId: id },
      orderBy: { createdAt: 'desc' },
    });
    const logCounts = await this.prisma.$queryRaw<{ run_id: string | null; count: number }[]>`
      SELECT run_id, COUNT(*) AS count FROM comments
      WHERE task_id = ${id} AND type = 'log' GROUP BY run_id`;
    return {
      items: runs.map((run) => ({
        id: run.id,
        run_number: run.runNumber,
        status: run.status,
        trigger_type: run.triggerType,
        agent_name: run.agentName,
        started_at: toIso(run.startedAt),
        finished_at: toIso(run.finishedAt),
        duration_ms: run.durationMs,
        progress: run.progress,
        progress_msg: run.progressMsg,
        summary: run.summary,
        error: run.error,
        log_count:
          Number(logCounts.find((row) => row.run_id === run.id)?.count ?? 0),
        artifacts: artifacts
          .filter((artifact) => artifact.runId === run.id)
          .map((artifact) => ({
            id: artifact.id,
            type: artifact.type,
            name: deriveArtifactName(parseJsonObject(artifact.metadata), artifact.uri, artifact.type),
            size_bytes: artifact.sizeBytes,
            mime_type: artifact.mimeType,
            created_at: toIso(artifact.createdAt),
          })),
        review: (() => {
          const review = reviews.find((item) => item.runId === run.id);
          if (!review) return null;
          return {
            id: review.id,
            conclusion: review.conclusion,
            suggestion: review.suggestion,
            reason: review.reason,
            detail: review.detail,
            return_to: review.returnTo,
            priority_adj: review.priorityAdj,
            created_at: toIso(review.createdAt),
          };
        })(),
      })),
    };
  }

  async runLogs(runId: string, page: number, pageSize: number) {
    const where = { runId, type: 'log' as const };
    const total = await this.prisma.comment.count({ where });
    const rows = await this.prisma.comment.findMany({
      where,
      orderBy: { createdAt: 'asc' },
      skip: (page - 1) * pageSize,
      take: pageSize,
    });
    return {
      items: rows.map((row) => ({
        id: row.id,
        content: row.content,
        author_name: row.authorName,
        created_at: toIso(row.createdAt),
      })),
      total,
      page,
      page_size: pageSize,
    };
  }

  async taskComments(id: string, types: string[], page: number, pageSize: number) {
    const total = await this.prisma.comment.count({
      where: { taskId: id, type: { in: types } },
    });
    const rows = await this.prisma.comment.findMany({
      where: { taskId: id, type: { in: types } },
      orderBy: { createdAt: 'desc' },
      skip: (page - 1) * pageSize,
      take: pageSize,
    });
    return {
      items: rows.map((row) => ({
        id: row.id,
        type: row.type,
        author_type: row.authorType,
        author_name: row.authorName,
        content: row.content,
        run_id: row.runId,
        created_at: toIso(row.createdAt),
      })),
      total,
      page,
      page_size: pageSize,
    };
  }

  async taskReviews(id: string) {
    const rows = await this.prisma.review.findMany({
      where: { taskId: id },
      orderBy: { createdAt: 'desc' },
    });
    return {
      items: rows.map((row) => ({
        id: row.id,
        run_id: row.runId,
        conclusion: row.conclusion,
        suggestion: row.suggestion,
        reason: row.reason,
        detail: row.detail,
        return_to: row.returnTo,
        priority_adj: row.priorityAdj,
        created_at: toIso(row.createdAt),
      })),
    };
  }

  async dependencies(id: string) {
    const detail = await this.getDetail(id);
    return { depends_on: detail.depends_on, blocks: detail.blocks };
  }

  // ---------------------------------------------------------------- 内部

  /**
   * 6.9.2：必填未填 → 不允许进「待执行」。
   * 刻意不复用 `normalizeCustomFields(full=true)`：那会连任务里已存的旧值一起重验，
   * 字段一旦停用，旧值就变成「字段定义不存在」，任务将永久卡在流转不出去的状态。
   * 这里只看存在性——`false` 是布尔字段的有效值，空串与 null/undefined 才算未填。
   */
  private async assertRequiredFields(task: Task): Promise<void> {
    const defs = await this.loadFieldDefs();
    const stored = parseJsonObject(task.customFields);
    const missing = [...defs.values()]
      .filter((def) => def.required && appliesToType(def, task.type))
      .filter((def) => {
        const value = stored[def.key];
        return value === undefined || value === null || value === '';
      })
      .map((def) => ({ key: def.key, label: def.label }));
    if (missing.length > 0) {
      throw new ApiException(
        'VALIDATION_FAILED',
        '必填字段未填写，不能进入待执行',
        missing.map((item) => ({
          path: `custom_fields.${item.key}`,
          code: 'required',
          message: `必填：${item.label}`,
        })),
      );
    }
  }

  private async requireTask(id: string): Promise<Task> {
    const task = await this.prisma.task.findUnique({ where: { id } });
    if (!task) throw new ApiException('NOT_FOUND', '任务不存在');
    return task;
  }

  private forbiddenMessage(
    reason: 'running-by-agent' | 'done-terminal' | 'self' | 'illegal',
    from: TaskStatus,
    to: TaskStatus,
  ): string {
    if (reason === 'running-by-agent') return USER_COPY.dragToRunning;
    if (reason === 'done-terminal') return USER_COPY.dragOutOfDone;
    if (reason === 'self') return '源列与目标列相同';
    return `不允许从「${STATUS_LABEL[from]}」流转到「${STATUS_LABEL[to]}」`;
  }

  private async setStatus(
    id: string,
    from: TaskStatus,
    to: TaskStatus,
    content: string,
  ): Promise<void> {
    await this.prisma.$transaction(async (tx) => {
      await tx.task.update({
        where: { id },
        data: {
          status: to,
          updatedAt: nowSql(),
          ...(to === 'BACKLOG' || to === 'READY'
            ? { stopReason: null, leaseId: null, leaseExpiresAt: null, currentRunId: null }
            : {}),
        },
      });
      await tx.comment.create({
        data: {
          id: newId(),
          taskId: id,
          authorType: 'system',
          type: 'status_change',
          content,
        },
      });
      await this.audit.record(
        {
          actorType: 'user',
          action: 'task_transition',
          targetType: 'task',
          targetId: id,
          before: { status: from },
          after: { status: to },
        },
        tx,
      );
    });
    if (to === 'DONE') await this.releaseDownstream(id);
  }

  /** 5.5：任务转 DONE 后，全部 blocks 前置已满足的下游发 task.unblocked。 */
  private async releaseDownstream(id: string): Promise<string[]> {
    const dependents = await this.prisma.$queryRaw<{ id: string }[]>`
      SELECT t.id FROM tasks t
      WHERE t.archived_at IS NULL AND t.status = 'READY'
        AND EXISTS (SELECT 1 FROM task_dependencies d WHERE d.task_id = t.id AND d.depends_on = ${id} AND d.type = 'blocks')
        AND NOT EXISTS (
          SELECT 1 FROM task_dependencies d2 JOIN tasks dep ON dep.id = d2.depends_on
          WHERE d2.task_id = t.id AND d2.type = 'blocks' AND dep.status != 'DONE'
        )`;
    for (const row of dependents) {
      this.events.emit('task.unblocked', { task_id: row.id });
      await this.notifications.push('task_unblocked', row.id, '前置任务已完成，该任务现在可被领取');
    }
    return dependents.map((row) => row.id);
  }

  private async recomputeUnblocked(dependents: { id: string; title: string }[]): Promise<string[]> {
    const unblocked: string[] = [];
    for (const row of dependents) {
      const remaining = await this.unfinishedDependentsOf(row.id);
      if (remaining === 0) {
        unblocked.push(row.id);
        this.events.emit('task.unblocked', { task_id: row.id });
      }
    }
    return unblocked;
  }

  private async unfinishedDependentsOf(id: string): Promise<number> {
    const rows = await this.prisma.$queryRaw<{ count: number }[]>`
      SELECT COUNT(*) AS count FROM task_dependencies d JOIN tasks dep ON dep.id = d.depends_on
      WHERE d.task_id = ${id} AND d.type = 'blocks' AND dep.status != 'DONE'`;
    return Number(rows[0]?.count ?? 0);
  }

  private async deleteArtifactFiles(uris: string[]): Promise<void> {
    const { rm } = await import('node:fs/promises');
    const path = await import('node:path');
    const { paths } = await import('../common/paths');
    for (const uri of uris) {
      const absolute = path.resolve(paths.artifactsDir(), '..', uri);
      await rm(absolute, { force: true, recursive: false }).catch(() => undefined);
    }
  }

  private async loadFieldDefs(): Promise<Map<string, FieldDefLike & { showOnCard: number }>> {
    const defs = await this.prisma.customFieldDef.findMany({ where: { enabled: 1 } });
    return new Map(
      defs.map((def) => [
        def.key,
        {
          key: def.key,
          label: def.label,
          type: def.type as FieldDefLike['type'],
          required: def.required === 1,
          options: parseFieldOptions(def.options),
          appliesTo: parseJsonArray(def.appliesTo),
          showOnCard: def.showOnCard,
        },
      ]),
    );
  }

  /**
   * 20.10：未在字段定义里登记的键、或值不合契约的键 → 422，details[] 指明键名。
   * `full = true` 时校验必填（创建场景）；`false` 时只校验提交的键（编辑场景）。
   */
  private async normalizeCustomFields(
    taskType: string,
    values: Record<string, unknown>,
    full: boolean,
  ): Promise<Record<string, unknown>> {
    const defs = await this.loadFieldDefs();
    const issues: { key: string; message: string }[] = [];
    const result: Record<string, unknown> = {};

    for (const [key, value] of Object.entries(values)) {
      const def = defs.get(key);
      if (!def) {
        issues.push({ key, message: '字段定义不存在或已停用' });
        continue;
      }
      if (!appliesToType(def, taskType)) {
        issues.push({ key, message: `该字段不适用于类型「${taskType}」` });
        continue;
      }
      const normalized = def.type === 'multiselect' ? normalizeMultiSelect(value) : value;
      const issue = validateFieldValue(def, normalized, { present: true });
      if (issue) {
        issues.push(issue);
        continue;
      }
      if (normalized !== undefined) result[key] = normalized;
    }

    if (full) {
      for (const def of defs.values()) {
        if (!def.required || !appliesToType(def, taskType)) continue;
        if (result[def.key] === undefined || result[def.key] === null) {
          issues.push({ key: def.key, message: `必填：${def.label}` });
        }
      }
    }

    if (issues.length > 0) {
      throw new ApiException(
        'VALIDATION_FAILED',
        '自定义字段校验失败',
        issues.map((issue) => ({ path: `custom_fields.${issue.key}`, code: 'field', message: issue.message })),
      );
    }
    return result;
  }

  private async getCard(id: string): Promise<TaskCardDto> {
    const rows = await this.prisma.$queryRaw<TaskRow[]>`
      SELECT ${Prisma.raw(TASK_ROW_COLUMNS)}
      FROM tasks t LEFT JOIN task_runs r ON r.id = t.current_run_id WHERE t.id = ${id}`;
    return (await this.decorate(rows))[0];
  }

  /** 给一批任务行补上阻塞明细、产物图标与卡片可见的自定义字段（20.7：卡片不为图标另发请求）。 */
  private async decorate(rows: TaskRow[]): Promise<TaskCardDto[]> {
    if (rows.length === 0) return [];
    const ids = rows.map((row) => row.id);
    const blocked = await this.prisma.$queryRaw<BlockedRow[]>`
      SELECT d.task_id, dep.id, dep.title
      FROM task_dependencies d JOIN tasks dep ON dep.id = d.depends_on
      WHERE d.task_id IN (${Prisma.join(ids)}) AND d.type = 'blocks' AND dep.status != 'DONE'
      ORDER BY d.task_id, dep.id`;
    const artifactRows = await this.prisma.$queryRaw<(ArtifactRow & { rn: number })[]>`
      SELECT task_id, id, type, uri, metadata FROM (
        SELECT task_id, id, type, uri, metadata,
               ROW_NUMBER() OVER (PARTITION BY task_id ORDER BY created_at DESC, id) AS rn
        FROM artifacts WHERE task_id IN (${Prisma.join(ids)})
      ) WHERE rn <= 5`;
    const defs = await this.loadFieldDefs();
    const cardDefs = [...defs.values()].filter((def) => def.showOnCard === 1);

    return rows.map((row) => {
      const artifacts: CardArtifact[] = artifactRows
        .filter((item) => item.task_id === row.id)
        .map((item) => ({
          id: item.id,
          type: item.type,
          name: deriveArtifactName(parseJsonObject(item.metadata), item.uri, item.type),
        }));
      const custom = parseJsonObject(row.custom_fields);
      return toCardDto(row, {
        blockedBy: blocked
          .filter((item) => item.task_id === row.id)
          .slice(0, 5)
          .map((item) => ({ id: item.id, title: item.title })),
        artifacts,
        cardFields: Object.fromEntries(
          cardDefs
            .filter((def) => custom[def.key] !== undefined)
            .map((def) => [def.key, custom[def.key]]),
        ),
      });
    });
  }

  private async buildFilters(query: BoardQuery): Promise<{ predicate: Prisma.Sql }> {
    const parts: Prisma.Sql[] = [];
    const priorities = (query.priority ?? []).map(Number).filter((value) => !Number.isNaN(value));
    if (priorities.length > 0) parts.push(Prisma.sql`t.priority IN (${Prisma.join(priorities)})`);
    if (query.type?.length) parts.push(Prisma.sql`t.type IN (${Prisma.join(query.type)})`);
    parts.push(...jsonFilterParts(query.tags, query.custom_fields));
    return { predicate: parts.length ? Prisma.sql`AND ${Prisma.join(parts, ' AND ')}` : Prisma.empty };
  }
}

function viewScope(view: BoardQuery['view']): {
  statuses: TaskStatus[];
  statusIn: Prisma.Sql;
  blockedPredicate: Prisma.Sql;
} {
  const all = Prisma.sql`t.status IN (${Prisma.join(BOARD_COLUMNS)})`;
  const none = Prisma.empty;
  switch (view) {
    case 'review':
      return { statuses: ['REVIEW'], statusIn: Prisma.sql`t.status = 'REVIEW'`, blockedPredicate: none };
    case 'failed':
      return { statuses: ['FAILED'], statusIn: Prisma.sql`t.status = 'FAILED'`, blockedPredicate: none };
    case 'claimable':
      return {
        statuses: ['READY'],
        statusIn: Prisma.sql`t.status = 'READY'`,
        blockedPredicate: Prisma.sql`AND NOT EXISTS (
          SELECT 1 FROM task_dependencies d JOIN tasks dep ON dep.id = d.depends_on
          WHERE d.task_id = t.id AND d.type = 'blocks' AND dep.status != 'DONE')`,
      };
    case 'blocked':
      return {
        statuses: ['READY'],
        statusIn: Prisma.sql`t.status = 'READY'`,
        blockedPredicate: Prisma.sql`AND EXISTS (
          SELECT 1 FROM task_dependencies d JOIN tasks dep ON dep.id = d.depends_on
          WHERE d.task_id = t.id AND d.type = 'blocks' AND dep.status != 'DONE')`,
      };
    default:
      return { statuses: [...BOARD_COLUMNS], statusIn: all, blockedPredicate: none };
  }
}

/** 13 章：`sort` 白名单之外的值一律回落默认，Agent 与时长不可排序。 */
function listOrderBy(sort: ListQuery['sort'], order: ListQuery['order']): Prisma.TaskOrderByWithRelationInput[] {
  const dir = order === 'asc' ? ('asc' as const) : ('desc' as const);
  const secondary: Prisma.TaskOrderByWithRelationInput = { id: 'asc' };
  switch (sort) {
    case 'id':
      return [{ id: dir }];
    case 'priority':
      return [{ priority: 'asc' }, { createdAt: 'asc' }];
    case 'status':
      return [{ status: dir }, secondary];
    case 'created_at':
      return [{ createdAt: dir }, secondary];
    default:
      return [{ updatedAt: dir }, secondary];
  }
}

function parseFieldOptions(raw: string | null): FieldDefLike['options'] {
  if (!raw) return null;
  try {
    const value: unknown = JSON.parse(raw);
    if (Array.isArray(value)) return value.map(String);
    if (value && typeof value === 'object') {
      const record = value as Record<string, unknown>;
      return {
        min: typeof record.min === 'number' ? record.min : undefined,
        max: typeof record.max === 'number' ? record.max : undefined,
      };
    }
    return null;
  } catch {
    return null;
  }
}

function pickAudit(task: Task): Record<string, unknown> {
  return {
    status: task.status,
    priority: task.priority,
    type: task.type,
    title: task.title,
    tags: parseJsonArray(task.tags),
    pinned: task.pinned,
  };
}

function defaultStatusCopy(from: TaskStatus, to: TaskStatus): string {
  if (to === 'READY') return `从「${STATUS_LABEL[from]}」移入待执行`;
  if (to === 'BACKLOG') return `从「${STATUS_LABEL[from]}」撤回需求池`;
  return `从「${STATUS_LABEL[from]}」移入「${STATUS_LABEL[to]}」`;
}
