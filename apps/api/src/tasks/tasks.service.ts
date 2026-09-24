import { Injectable } from '@nestjs/common';
import { Prisma, type Task } from '@prisma/client';
import { ApiException, USER_COPY } from '../contract/errors';
import {
  ARTIFACT_TYPES,
  BOARD_COLUMNS,
  DEFAULT_GROUP_ID,
  REVIEW_CONCLUSIONS,
  RUN_STATUS,
  STATUS_LABEL,
  TAGS_MAX_PER_TASK,
  TRIGGER_TYPES,
  isKnownEnum,
  type TaskStatus,
} from '../contract/enums';
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
import { SkillsService } from '../skills/skills.service';
import { parseSkillRefs } from '../skills/skills.dto';
import type { RequestAuth } from '../auth/auth.scope';
import { isArtifactMissing } from '../artifacts/artifact-storage';
import { ArtifactsService } from '../artifacts/artifacts.service';
import { reportUnknownEnumValue } from '../common/unknown-enum';
import { AuditService } from '../infra/audit.service';
import { EventsService } from '../infra/events.service';
import { AppLogger } from '../infra/logger';
import { PrismaService } from '../infra/prisma.service';
import { SettingsService } from '../infra/settings.service';
import { NotificationsService } from '../infra/notifications.service';
import {
  aggregateStatus,
  deriveArtifactName,
  parseJsonArray,
  parseJsonObject,
  toCardDto,
  TASK_ROW_COLUMNS,
  toNumOrNull,
  type CardArtifact,
  type RunArtifactDto,
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
    /** 4.3.1 规则 4 / 验收 38：删除任务时产物目录由产物侧负责清（路径校验只有一份）。 */
    private readonly artifacts: ArtifactsService,
    /** 0919 10.3：skills 绑定的归属/版本校验由技能侧负责。 */
    private readonly skillsService: SkillsService,
    private readonly logger: AppLogger,
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
    const parentId = input.parent_task_id ? await this.assertParent(input.parent_task_id) : null;
    if (input.group_id) await this.assertGroup(input.group_id);

    const id = await this.prisma.$transaction(async (tx) => {
      const taskId = await nextTaskId(tx);
      await tx.task.create({
        data: {
          id: taskId,
          // §5.2（W1-D1）：未指定分组的新任务归入默认分组——唯一建任务入口
          // （REST/agent/MCP 都汇到这一个 create），兜底只写一次。
          groupId: input.group_id ?? DEFAULT_GROUP_ID,
          parentTaskId: parentId,
          sortOrder: input.sort_order ?? 0,
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

    // §8.6：载荷带 origin_type，前端据此判断是否挂 5 秒撤销入口。REST/存量路径落的都是默认 user 来源。
    this.events.emit('task.created', { id, origin_type: 'user' });
    return this.getDetail(id);
  }

  async patch(id: string, input: TaskPatchInput): Promise<TaskDetailDto> {
    const before = await this.requireTask(id);
    if (before.status === 'RUNNING') {
      throw new ApiException('TASK_RUNNING', '执行中的任务不可编辑，请先强制停止');
    }
    return this.applyPatch(id, before, input, { actorType: 'user' });
  }

  /**
   * v0.0.4 §16.1 `update_task`（Agent 面全字段 PATCH）的窄入口。
   *
   * 与 REST 的 `patch` 只差开头那句「RUNNING 即拒」——守卫在 `WritebackService.updateTask`
   * 里已按状态三支裁过：走到这里的 RUNNING 任务必定是 `leases.verify` 通过的当前持有者，
   * 它是唯一写入方，不存在 8.1 那句守卫要防的「人正在 UI 上编辑 / 强制停止打架」的并发场景。
   * 不改 REST 行为（那条路径仍走 `patch`），字段级校验也仍然只有 `applyPatch` 一份实现。
   */
  async patchAsAgent(id: string, input: TaskPatchInput, actorName: string): Promise<TaskDetailDto> {
    const before = await this.requireTask(id);
    return this.applyPatch(id, before, input, { actorType: 'agent', actorName });
  }

  /**
   * 8.1 的编辑落点（REST 与 Agent 共用这一份）：只写 input 里出现的列，
   * 审计 `task_update` + `task.updated` 事件同样在这里发，两条入口不各写一套。
   */
  private async applyPatch(
    id: string,
    before: Task,
    input: TaskPatchInput,
    actor: { actorType: 'user' | 'agent'; actorName?: string },
  ): Promise<TaskDetailDto> {
    const data: Prisma.TaskUpdateInput = { updatedAt: nowSql() };
    if (input.title !== undefined) data.title = input.title;
    if (input.description !== undefined) data.description = input.description;
    if (input.priority !== undefined) data.priority = Number(input.priority);
    if (input.pinned !== undefined) data.pinned = input.pinned ? 1 : 0;
    if (input.due_at !== undefined) data.dueAt = input.due_at ? toDateOnly(input.due_at) : null;
    if (input.group_id !== undefined) {
      if (input.group_id) {
        await this.assertGroup(input.group_id);
        data.group = { connect: { id: input.group_id } };
      } else {
        data.group = { disconnect: true };
      }
    }
    if (input.parent_task_id !== undefined) {
      // 0919 跨分组移动：置 null 脱离需求；挂新需求走 assertParent（类型/层级校验），
      // 自身已挂子任务时不能变成别人的子任务（层级会超 2 层）。
      if (input.parent_task_id === null) {
        data.parent = { disconnect: true };
      } else {
        const childCount = await this.prisma.task.count({ where: { parentTaskId: id } });
        if (childCount > 0) {
          throw new ApiException('VALIDATION_FAILED', '已有子任务的任务不能再挂到其他需求下', [
            { path: 'parent_task_id', code: 'too_deep', message: '该任务自身是父任务' },
          ]);
        }
        await this.assertParent(input.parent_task_id);
        data.parent = { connect: { id: input.parent_task_id } };
      }
    }
    if (input.sort_order !== undefined) data.sortOrder = input.sort_order;
    if (input.tags !== undefined) data.tags = JSON.stringify(input.tags);
    if (input.required_capabilities !== undefined) {
      data.requiredCapabilities = JSON.stringify(input.required_capabilities);
    }
    if (input.skills !== undefined) {
      // 10.3：逐个校验归属/存在/版本（缺省补 current），存 JSON 引用。
      data.skills = await this.skillsService.normalizeTaskBindings(input.skills);
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
      actorType: actor.actorType,
      actorName: actor.actorName,
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
          // 4.3：通过时三字段为选填，落库写 ''（reviews 列 NOT NULL），不引入 nullable 涟漪。
          suggestion: input.suggestion ?? '',
          reason: input.reason ?? '',
          detail: input.detail ?? '',
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
            ? `审核通过，已完成（${(input.suggestion ?? '').slice(0, 60)}）`
            : `驳回退回「${STATUS_LABEL[to]}」（${(input.reason ?? '').slice(0, 60)}）`,
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

  /**
   * 4.3.1 规则 4：物理删除 + 级联产物目录；RUNNING 必须先强制停止。
   *
   * v0.0.4 W8-a3 §8.6/§8.7（r3）撤销守卫：「5 秒撤销」= UI 在 5 秒窗口内调用本存量端点，
   * 时限归前端（服务端不复核窗口），服务端守的是「仅允许撤销 origin_type=agent 且未领取」——
   * agent 直建且未领取（无 lease_id / claimed_at）的任务允许 UI 凭证删除，并在
   * task_creation_logs 补记一条 user_action='cancelled' 流水（撤销与创建/取消/超时同表同词表）；
   * 已领取或非 agent 来源沿用现行规则（RUNNING/子任务护栏不变），不记撤销流水。
   */
  async remove(id: string): Promise<{
    id: string;
    deleted_runs: number;
    unblocked_ids: string[];
    /** §8.6：本次删除是否按「撤销 agent 直建任务」记账。 */
    undone: boolean;
  }> {
    const task = await this.requireTask(id);
    if (task.status === 'RUNNING') {
      throw new ApiException('TASK_RUNNING', '执行中的任务不可删除，请先强制停止');
    }
    // 0919：父任务还挂着子任务时不允许删，先删/迁子任务。
    const childCount = await this.prisma.task.count({ where: { parentTaskId: id } });
    if (childCount > 0) {
      throw new ApiException('ILLEGAL_TRANSITION', `该任务还有 ${childCount} 个子任务，请先删除或迁移子任务`, undefined, {
        children: childCount,
      });
    }
    const undone = task.originType === 'agent' && !task.leaseId && !task.claimedAt;
    const runCount = await this.prisma.taskRun.count({ where: { taskId: id } });
    const dependents = await this.unfinishedDependents(id);

    await this.prisma.$transaction(async (tx) => {
      await tx.task.delete({ where: { id } });
      if (undone) {
        // 撤销流水与任务删除同事务：task_creation_logs.task_id 无外键（0013），
        // 物理删行后日志仍可读；source 记 'ui' 标明这是 UI 撤销动作的记账而非创建通道。
        await tx.$executeRawUnsafe(
          `INSERT INTO task_creation_logs (task_id, session_id, agent_name, source, confirmation, user_action)
           VALUES (?, ?, ?, 'ui', ?, 'cancelled')`,
          id,
          task.originSessionId,
          task.originAgent,
          task.confirmationMode,
        );
      }
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

    // 验收 38：删的是 `artifacts/{task_id}/` 整个目录，而不是逐条 uri 删文件——
    // 上传半路失败留在目录里的残留（库里根本没有行）也必须一起带走。
    // 此刻行已经级联删掉了，磁盘侧再失败也不该把这次删除整个报成 500：记 error 后继续。
    try {
      this.artifacts.cleanupTaskDir(id);
    } catch (error) {
      this.logger.error(
        `任务 ${id} 的产物目录清理失败：${(error as Error).message}`,
        undefined,
        'tasks',
      );
    }
    const unblocked = await this.recomputeUnblocked(dependents);
    this.events.emit('task.deleted', { task_id: id, unblocked_ids: unblocked });
    return { id, deleted_runs: runCount, unblocked_ids: unblocked, undone };
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
    await this.requireTask(id);
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
      ...(await this.familyFields(source)),
      description: source.description,
      required_capabilities: parseJsonArray(source.required_capabilities),
      current_run_id: source.current_run_id,
      stop_reason: source.stop_reason,
      archived_at: toIso(source.archived_at),
      created_at: toIso(source.created_at),
      claimed_at: toIso(source.claimed_at),
      // 卡片只带 show_on_card 的字段，详情抽屉要看到全部值（20.10）。
      custom_fields: parseJsonObject(source.custom_fields),
      // 0919 10.3：技能绑定引用（前端据此渲染技能标签 Tab）。
      skills: parseSkillRefs(source.skills as string | null),
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
    if (query.group_id !== undefined) {
      // `none`：未分配分组的任务。
      where.groupId = query.group_id === 'none' ? null : query.group_id;
    }
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
      SELECT t.id FROM tasks t
      WHERE ${Prisma.join(parts, ' AND ')}`;
    return rows.map((row) => row.id);
  }

  async tags(): Promise<string[]> {
    const rows = await this.prisma.$queryRaw<{ tags: string | null }[]>`
      SELECT tags FROM tasks
      WHERE tags IS NOT NULL AND tags != '[]'`;
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
    // 20.2 末段 / 验收 43：详情读路径碰到表外枚举值原样透传，但必须留下一条 error 日志。
    for (const run of runs) {
      this.noteEnum('task_runs', 'status', RUN_STATUS, run.status);
      this.noteEnum('task_runs', 'trigger_type', TRIGGER_TYPES, run.triggerType);
    }
    for (const artifact of artifacts) {
      this.noteEnum('artifacts', 'type', ARTIFACT_TYPES, artifact.type);
    }
    for (const review of reviews) {
      this.noteEnum('reviews', 'conclusion', REVIEW_CONCLUSIONS, review.conclusion);
    }
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
          .map((artifact): RunArtifactDto => ({
            id: artifact.id,
            type: artifact.type,
            name: deriveArtifactName(parseJsonObject(artifact.metadata), artifact.uri, artifact.type),
            size_bytes: artifact.sizeBytes,
            mime_type: artifact.mimeType,
            created_at: toIso(artifact.createdAt),
            // 验收 42：丢失标记在这里就要给到，列表层直接能标「已丢失」，不用点开预览框。
            missing: isArtifactMissing(artifact.type, artifact.uri),
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
    await this.requireRunTask(runId);
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
    await this.requireTask(id);
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
    await this.requireTask(id);
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

  /** run → task 归属链校验（日志读取端点用，run 本身不带任务列）。 */
  private async requireRunTask(runId: string): Promise<void> {
    const run = await this.prisma.taskRun.findUnique({ where: { id: runId } });
    if (!run) throw new ApiException('NOT_FOUND', '执行记录不存在');
    await this.requireTask(run.taskId);
  }

  /** 0919：父必须是「需求」且自身不是子任务（嵌套最多 2 层）。 */
  private async assertParent(parentId: string): Promise<string> {
    const parent = await this.prisma.task.findUnique({ where: { id: parentId } });
    if (!parent) throw new ApiException('NOT_FOUND', `父任务 ${parentId} 不存在`);
    if (parent.parentTaskId) {
      throw new ApiException('VALIDATION_FAILED', '任务层级最多两层：子任务下不能再挂子任务', [
        { path: 'parent_task_id', code: 'too_deep', message: `父任务 ${parentId} 本身已是子任务` },
      ]);
    }
    if (parent.type !== '需求') {
      throw new ApiException('VALIDATION_FAILED', `父任务必须是「需求」类型，${parentId} 的类型是「${parent.type}」`, [
        { path: 'parent_task_id', code: 'parent_type', message: '父任务类型必须是需求' },
      ]);
    }
    return parent.id;
  }

  /**
   * 分组归属校验。v0.0.4 W4 §5.6：归档分组转只读——不能再向该组建任务，也不能把
   * 任务移动进去（创建/迁移的目标组必须活跃）；404 语义保持不变（不存在的组仍是 NOT_FOUND）。
   */
  private async assertGroup(groupId: string): Promise<void> {
    const group = await this.prisma.group.findUnique({ where: { id: groupId } });
    if (!group) throw new ApiException('NOT_FOUND', `分组 ${groupId} 不存在`);
    if (group.status === 'ARCHIVED') {
      throw new ApiException(
        'GROUP_ARCHIVED',
        `分组「${group.name}」已归档，只读；不能向该组建任务或移动任务进来`,
        undefined,
        { group_id: group.id },
      );
    }
  }

  /**
   * 详情里的父子信息：children 全量列表 + aggregate（完成/总数、聚合状态），
   * 有父任务时补 parent 摘要（含父任务的子任务完成度）。
   */
  private async familyFields(
    source: { id: string; parent_task_id?: string | null },
  ): Promise<Partial<TaskDetailDto>> {
    const children = await this.prisma.task.findMany({
      where: { parentTaskId: source.id },
      orderBy: [{ sortOrder: 'asc' }, { createdAt: 'asc' }],
      select: { id: true, title: true, type: true, status: true, priority: true, sortOrder: true },
    });
    let parent: TaskDetailDto['parent'] = null;
    if (source.parent_task_id) {
      const rows = await this.prisma.$queryRaw<{ id: string; title: string; done: number; total: number }[]>`
        SELECT p.id, p.title,
          (SELECT COUNT(*) FROM tasks c WHERE c.parent_task_id = p.id) AS total,
          (SELECT COUNT(*) FROM tasks c WHERE c.parent_task_id = p.id AND c.status = 'DONE') AS done
        FROM tasks p WHERE p.id = ${source.parent_task_id}`;
      const row = rows[0];
      if (row) parent = { id: row.id, title: row.title, done: Number(row.done), total: Number(row.total) };
    }
    return {
      parent,
      children: children.map((child) => ({
        id: child.id,
        title: child.title,
        type: child.type,
        status: child.status as TaskStatus,
        priority: child.priority,
        sort_order: child.sortOrder,
      })),
      aggregate:
        children.length > 0
          ? { total: children.length, done: children.filter((c) => c.status === 'DONE').length, status: aggregateStatus(children.map((c) => c.status)) }
          : null,
    };
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

  /**
   * 20.2 末段 / 验收 43：库里读到枚举表之外的值时**不改数据、不抛错**，原样透传给界面渲染
   * 「未知（原值）」，服务端这边只补一条 error 日志。
   */
  private noteEnum(
    table: string,
    field: string,
    allowed: readonly string[],
    value: unknown,
  ): void {
    if (isKnownEnum(allowed, value)) return;
    this.reportUnknownEnum(table, field, String(value));
  }

  /** 日志出口：措辞与「同一 (字段,值) 每进程只记一次」的去重都在 `reportUnknownEnumValue` 里。 */
  private reportUnknownEnum(table: string, field: string, value: string): void {
    reportUnknownEnumValue(table, field, value, this.logger);
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
      FROM tasks t LEFT JOIN task_runs r ON r.id = t.current_run_id
      WHERE t.id = ${id}`;
    return (await this.decorate(rows))[0];
  }

  /** 给一批任务行补上阻塞明细、产物图标、卡片可见的自定义字段与父任务摘要（20.7：卡片不为图标另发请求）。 */
  private async decorate(rows: TaskRow[]): Promise<TaskCardDto[]> {
    if (rows.length === 0) return [];
    const ids = rows.map((row) => row.id);
    const parents = await this.parentSummaries(rows);
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
        parent: parents.get(row.parent_task_id ?? '') ?? null,
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
        // 20.2 末段 / 验收 43：`status_label` 查不到就是表外值，界面拿原值渲染「未知（原值）」，
        // 服务端在这里补 error 日志。看板与列表每次刷新都会重读同一行，去重由上报器负责。
        reportUnknownEnum: (table, field, value) => this.reportUnknownEnum(table, field, value),
      });
    });
  }

  /** 卡片上的父任务摘要：一次查询补齐本批任务引用到的全部父任务（含其子任务完成度）。 */
  private async parentSummaries(
    rows: { parent_task_id?: string | null }[],
  ): Promise<Map<string, { id: string; title: string; done: number; total: number }>> {
    const parentIds = [...new Set(rows.map((row) => row.parent_task_id).filter((id): id is string => Boolean(id)))];
    if (parentIds.length === 0) return new Map();
    const rowsOut = await this.prisma.$queryRaw<{ id: string; title: string; done: number; total: number }[]>`
      SELECT p.id, p.title,
        (SELECT COUNT(*) FROM tasks c WHERE c.parent_task_id = p.id) AS total,
        (SELECT COUNT(*) FROM tasks c WHERE c.parent_task_id = p.id AND c.status = 'DONE') AS done
      FROM tasks p
      WHERE p.id IN (${Prisma.join(parentIds)})`;
    return new Map(
      rowsOut.map((row) => [
        row.id,
        { id: row.id, title: row.title, done: Number(row.done), total: Number(row.total) },
      ]),
    );
  }

  private async buildFilters(query: BoardQuery): Promise<{ predicate: Prisma.Sql }> {
    const parts: Prisma.Sql[] = [];
    if (query.groups?.length) {
      parts.push(inListPredicate(Prisma.sql`t.group_id`, query.groups));
    } else {
      // §5.6（W4）：归档分组从看板默认隐藏——未显式按分组过滤时排除归档组任务；
      // 显式选中归档组（groups 过滤）仍可见（分组过滤 chip 是唯一的这个口）。
      parts.push(Prisma.sql`NOT EXISTS (
        SELECT 1 FROM groups g WHERE g.id = t.group_id AND g.status = 'ARCHIVED')`);
    }
    if (query.requirements?.length) {
      parts.push(inListPredicate(Prisma.sql`t.parent_task_id`, query.requirements));
    }
    if (query.agents?.length) {
      // 卡片上的 Agent 来自当前 run（decorate 同口径）；无 current_run 视为「未设置」。
      parts.push(
        inListPredicate(
          Prisma.sql`(SELECT r.agent_name FROM task_runs r WHERE r.id = t.current_run_id)`,
          query.agents,
        ),
      );
    }
    const priorities = (query.priority ?? []).map(Number).filter((value) => !Number.isNaN(value));
    if (priorities.length > 0) parts.push(Prisma.sql`t.priority IN (${Prisma.join(priorities)})`);
    if (query.type?.length) parts.push(Prisma.sql`t.type IN (${Prisma.join(query.type)})`);
    parts.push(...jsonFilterParts(query.tags, query.custom_fields));
    return { predicate: parts.length ? Prisma.sql`AND ${Prisma.join(parts, ' AND ')}` : Prisma.empty };
  }
}

/** `column IN (values)` 且 values 里的 `none` 归一为 `column IS NULL`（OR 语义）。 */
function inListPredicate(column: Prisma.Sql, values: string[]): Prisma.Sql {
  const ids = values.filter((value) => value !== 'none');
  const eq = ids.length ? Prisma.sql`${column} IN (${Prisma.join(ids)})` : null;
  const isNull = values.includes('none') ? Prisma.sql`${column} IS NULL` : null;
  if (eq && isNull) return Prisma.sql`(${eq} OR ${isNull})`;
  return (eq ?? isNull)!;
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
