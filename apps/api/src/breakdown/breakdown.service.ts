import { Injectable } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import { ApiException } from '../contract/errors';
import {
  DEFAULT_GROUP_ID,
  type BreakdownSessionStatus,
} from '../contract/enums';
import { newId, nextTaskId } from '../contract/ids';
import { nowSql } from '../contract/time';
import { BREAKDOWN_REVIEWING_TIMEOUT_MS } from '../jobs/breakdown-timeout.job';
import { AuditService } from '../infra/audit.service';
import { EventsService } from '../infra/events.service';
import { PrismaService } from '../infra/prisma.service';

/** §7.2 阶段 1：begin_breakdown 入参（需求文本、分组、父任务标题、预估任务数）。 */
export interface BreakdownBeginInput {
  requirement_text: string;
  group_id?: string | null;
  parent_title: string;
  parent_description?: string | null;
  estimated_tasks?: number | null;
  agent_name?: string | null;
  skill_used?: string | null;
}

/** §7.2 阶段 4：report_task_draft 单条草案。ref 是会话内稳定引用号（依赖边以它为坐标）。 */
export interface BreakdownDraftInput {
  ref: string;
  title: string;
  description?: string | null;
  priority?: number;
  /** §7.5（r3）：Agent 常以技能名填写，finish 时统一解析成 id。 */
  skill_ids?: string[];
  acceptance?: string[];
  depends_on?: string[];
  sort_order?: number;
}

/** §7.5：finish 时的技能解析报告（确认页据此标「同名歧义」/黄色告警）。 */
export interface SkillResolutionReport {
  /** 同名多技能、已按「取最近更新者」落定。 */
  ambiguous: { ref: string; name: string; skill_id: string; candidates: string[] }[];
  /** 无法解析：草案里保留原值，确认页告警、不阻断创建（§7.4 可替换/删除）。 */
  unresolved: { ref: string; name: string }[];
}

interface SessionRow {
  id: string;
  requirement_text: string;
  group_id: string | null;
  parent_title: string;
  parent_description: string | null;
  parent_task_id: string | null;
  status: string;
  agent_name: string | null;
  skill_used: string | null;
  estimated_tasks: number | null;
  actual_tasks: number | null;
  created_at: string;
  finished_at: string | null;
  confirmed_at: string | null;
  cancelled_at: string | null;
}

interface DraftRow {
  id: string;
  session_id: string;
  ref: string;
  title: string;
  description: string | null;
  priority: number | null;
  skill_ids: string | null;
  acceptance: string | null;
  depends_on: string | null;
  sort_order: number | null;
}

const SESSION_COLUMNS = `
  id, requirement_text, group_id, parent_title, parent_description, parent_task_id,
  status, agent_name, skill_used, estimated_tasks, actual_tasks,
  created_at, finished_at, confirmed_at, cancelled_at`;

/**
 * v0.0.4 W7 需求拆解的服务层（§7 全链路的后端底座）。
 *
 * 生命周期：begin（receiving）→ report_progress / report_draft（receiving 期可多次，
 * 同 ref 重报即更新）→ finish（技能名→ID 统一解析 §7.5，转 reviewing）→
 * confirm（单事务批量建父任务 + 子任务 + 依赖边，全成或全滚 §7.8）或 cancel。
 * MCP 工具面与 REST 端点由后续切片接入，本文件只做状态与数据的一致性。
 */
@Injectable()
export class BreakdownService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly events: EventsService,
  ) {}

  // ---------------------------------------------------------------- 阶段 1：发起

  async begin(input: BreakdownBeginInput): Promise<SessionDtoShape> {
    const requirementText = text(input.requirement_text, 'requirement_text');
    const parentTitle = text(input.parent_title, 'parent_title');
    if (input.group_id) await this.assertActiveGroup(input.group_id);
    if (input.estimated_tasks !== undefined && input.estimated_tasks !== null) {
      assertEstimated(input.estimated_tasks);
    }

    const id = newId();
    await this.prisma.$executeRawUnsafe(
      `INSERT INTO breakdown_sessions
         (id, requirement_text, group_id, parent_title, parent_description, status,
          agent_name, skill_used, estimated_tasks)
       VALUES (?, ?, ?, ?, ?, 'receiving', ?, ?, ?)`,
      id,
      requirementText,
      input.group_id ?? null,
      parentTitle,
      input.parent_description ?? null,
      input.agent_name ?? null,
      input.skill_used ?? null,
      input.estimated_tasks ?? null,
    );
    this.events.emit('breakdown.started', { session_id: id });
    return this.requireSession(id);
  }

  // ---------------------------------------------------------------- 阶段 3/4：进度与草案

  async reportProgress(
    sessionId: string,
    input: { step: number; total: number; message?: string | null },
  ): Promise<void> {
    const session = await this.requireSession(sessionId);
    this.assertStatus(session, 'receiving', ['receiving']);
    if (!Number.isInteger(input.step) || !Number.isInteger(input.total) || input.step < 1 || input.total < input.step) {
      throw new ApiException('VALIDATION_FAILED', '进度 step/total 必须为正整数且 step ≤ total', undefined, {
        session_id: sessionId,
      });
    }
    await this.prisma.$executeRawUnsafe(
      `INSERT INTO breakdown_progress (session_id, step, total, message) VALUES (?, ?, ?, ?)`,
      sessionId,
      input.step,
      input.total,
      input.message ?? null,
    );
    this.events.emit('breakdown.progress', { session_id: sessionId, step: input.step, total: input.total });
  }

  /**
   * 同 (session_id, ref) 再上报即整体覆盖（§7.6 UNIQUE；阶段 4 允许 Agent 修订草案）。
   *
   * 守卫（工单 #34 B 口径）：会话 receiving 照旧；reviewing 只放行「被重新生成」的那条
   * 草案——即 §7.4 用户点了「重新生成」、行上挂着 regeneration_pending 哨兵、正等 Agent
   * 重报的 ref。哨兵草案本就是空壳（title 占位、描述/技能/验收全清），覆盖它不碰人工
   * 编辑成果；其余 reviewing 期重报（无哨兵的新旧 ref）仍 409，终态一律不变。
   */
  async reportDraft(sessionId: string, input: BreakdownDraftInput): Promise<DraftDtoShape> {
    const session = await this.requireSession(sessionId);
    const regenerationReplay = await this.isRegenerationReplay(session, input.ref);
    if (!regenerationReplay) {
      this.assertStatus(session, 'receiving', ['receiving']);
    }
    const ref = text(input.ref, 'ref');
    const title = text(input.title, 'title');
    const priority = input.priority ?? 3;
    if (!Number.isInteger(priority) || priority < 0 || priority > 3) {
      throw new ApiException('VALIDATION_FAILED', 'priority 取值 0~3（20 章）', undefined, { session_id: sessionId });
    }
    const dependsOn = dedupe((input.depends_on ?? []).map((r) => text(r, 'depends_on')));
    if (dependsOn.includes(ref)) {
      throw new ApiException('DEPENDENCY_CYCLE', '草案不能依赖自身');
    }
    // finish 只在 receiving 跑，reviewing 期重报没有下一班解析车——技能名就地按 §7.5
    // 同一判解析（resolveSkills 原样复用），否则未解析的名字会在 confirm 侧被丢弃。
    const skillIds = regenerationReplay
      ? await this.resolveSkillIds(sessionId, ref, input.skill_ids ?? [])
      : input.skill_ids ?? [];

    const id = newId();
    const values = [
      id,
      sessionId,
      ref,
      title,
      input.description ?? null,
      priority,
      JSON.stringify(skillIds),
      JSON.stringify(input.acceptance ?? []),
      JSON.stringify(dependsOn),
      input.sort_order ?? 0,
    ];
    const sql = `INSERT INTO breakdown_drafts (id, session_id, ref, title, description, priority, skill_ids, acceptance, depends_on, sort_order)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(session_id, ref) DO UPDATE SET
         title = excluded.title, description = excluded.description, priority = excluded.priority,
         skill_ids = excluded.skill_ids, acceptance = excluded.acceptance,
         depends_on = excluded.depends_on, sort_order = excluded.sort_order`;
    if (regenerationReplay) {
      // 哨兵覆盖与用户侧写端点同款并发守卫：'reviewing' 判定与写在同一事务原子命中，
      // 抢先流转（confirm / 超时收敛）即 409，不给「已确认的会话」补草案。
      await this.prisma.$transaction(async (tx) => {
        this.assertReviewingGuard(await guardReviewingUpdate(tx, sessionId));
        await tx.$executeRawUnsafe(sql, ...values);
      });
    } else {
      await this.prisma.$executeRawUnsafe(sql, ...values);
    }
    const row = await this.drafts(sessionId);
    const dto = toDraftDto(row.find((d) => d.ref === ref)!);
    this.events.emit('breakdown.task_draft', { session_id: sessionId, ref });
    return dto;
  }

  /**
   * #34：本条上报是否属于「重报被重新生成的草案」。仅 reviewing + 该 ref 已存在且
   * depends_on 列仍是 regeneration_pending 哨兵时为真；ref 空白/未知/无哨兵一律假
   * （调用方据此回落到原 409 守卫，reviewing 期新增 ref 依旧被拒）。
   */
  private async isRegenerationReplay(session: SessionDtoShape, rawRef: string): Promise<boolean> {
    if (session.status !== 'reviewing') return false;
    const ref = typeof rawRef === 'string' ? rawRef.trim() : '';
    if (!ref) return false;
    const row = (await this.drafts(session.id)).find((draft) => draft.ref === ref);
    return row !== undefined && hasRegenerationFlag(row.depends_on);
  }

  /**
   * #34：重报哨兵草案时就地跑 §7.5 解析——复用 resolveSkills 的同一判据（id 直通、
   * 名字精确匹配、同名取最近更新者），传回已解析值；报告不外抛（会话已过 finish，
   * 确认页的告警由 GET 侧 annotateSkills 逐条复原，条款 81 既有口径）。
   */
  private async resolveSkillIds(sessionId: string, ref: string, skillIds: string[]): Promise<string[]> {
    if (skillIds.length === 0) return [];
    const { updated } = await this.resolveSkills([
      {
        id: `replay-${ref}`,
        session_id: sessionId,
        ref,
        title: '',
        description: null,
        priority: null,
        skill_ids: JSON.stringify(skillIds),
        acceptance: '[]',
        depends_on: '[]',
        sort_order: null,
      },
    ]);
    return updated[0]?.skillIds ?? skillIds;
  }

  // ---------------------------------------------------------------- 阶段 5：完成（技能解析闭环 §7.5）

  async finish(sessionId: string): Promise<{ session: SessionDtoShape; skill_resolution: SkillResolutionReport }> {
    const session = await this.requireSession(sessionId);
    this.assertStatus(session, 'receiving', ['receiving']);
    const drafts = await this.drafts(sessionId);
    this.assertDraftGraph(drafts, sessionId);
    const resolution = await this.resolveSkills(drafts);

    await this.prisma.$transaction(async (tx) => {
      for (const draft of resolution.updated) {
        await tx.$executeRawUnsafe(
          `UPDATE breakdown_drafts SET skill_ids = ? WHERE id = ?`,
          JSON.stringify(draft.skillIds),
          draft.id,
        );
      }
      await tx.$executeRawUnsafe(
        `UPDATE breakdown_sessions SET status = 'reviewing', finished_at = datetime('now'), actual_tasks = ? WHERE id = ?`,
        drafts.length,
        sessionId,
      );
    });
    this.events.emit('breakdown.finished', { session_id: sessionId, actual_tasks: drafts.length });
    return { session: await this.requireSession(sessionId), skill_resolution: resolution.report };
  }

  // ---------------------------------------------------------------- 阶段 7：确认创建（单事务，全成或全滚 §7.8）

  async confirm(sessionId: string): Promise<{ session: SessionDtoShape; parent_task_id: string; task_ids: string[] }> {
    const session = await this.requireSession(sessionId);
    this.assertStatus(session, 'reviewing', ['reviewing']);
    // 20.3-10：会话保留 7 天，到期草案可查不可确认。定时收敛（BreakdownTimeoutJob）未及
    // 跑到的窗口由 confirm 自行拦截：状态守卫 UPDATE 命中即标 interrupted 并拒绝。
    const retentionCutoff = nowSql(new Date(Date.now() - BREAKDOWN_REVIEWING_TIMEOUT_MS));
    const expired = await this.prisma.$executeRawUnsafe(
      `UPDATE breakdown_sessions SET status = 'interrupted'
       WHERE id = ? AND status = 'reviewing' AND COALESCE(finished_at, created_at) < ?`,
      sessionId,
      retentionCutoff,
    );
    if (expired > 0) {
      await this.audit.record({
        actorType: 'system',
        actorName: 'breakdown_timeout',
        action: 'breakdown_timeout',
        targetType: 'breakdown_session',
        targetId: sessionId,
        before: { status: 'reviewing' },
        after: { status: 'interrupted', reason: '用户超 7 天未确认', trigger: 'confirm_guard' },
      });
      throw new ApiException(
        'BREAKDOWN_BAD_STATE',
        '拆解会话已超过 7 天保留期，标记为中断（草案可查不可确认）',
        undefined,
        { session_id: sessionId, status: 'interrupted' },
      );
    }
    const drafts = (await this.drafts(sessionId)).sort(
      (a, b) => (a.sort_order ?? 0) - (b.sort_order ?? 0) || a.ref.localeCompare(b.ref),
    );
    this.assertDraftGraph(drafts, sessionId);
    if (session.group_id) await this.assertActiveGroup(session.group_id);

    // 确认页可替换/删除告警技能（§7.4）：落库只认真实技能 id，表外值（未解析的名字）丢弃。
    const allSkillRefs = dedupe(unionSkillRefs(drafts));
    const skillIds = new Set(
      allSkillRefs.length === 0
        ? []
        : (
            await this.prisma.$queryRawUnsafe<{ id: string }[]>(
              `SELECT id FROM skills WHERE id IN (${placeholders(allSkillRefs.length)})`,
              ...allSkillRefs,
            )
          ).map((row) => row.id),
    );

    const created = await this.prisma.$transaction(async (tx) => {
      const parentTaskId = await nextTaskId(tx);
      await tx.$executeRawUnsafe(
        `INSERT INTO tasks (id, group_id, type, title, description, status, priority, skills, breakdown_session_id)
         VALUES (?, ?, '需求', ?, ?, 'BACKLOG', 3, '[]', ?)`,
        parentTaskId,
        session.group_id ?? DEFAULT_GROUP_ID,
        session.parent_title,
        session.parent_description,
        sessionId,
      );

      const refToTask = new Map<string, string>();
      const taskIds: string[] = [];
      for (const draft of drafts) {
        const taskId = await nextTaskId(tx);
        refToTask.set(draft.ref, taskId);
        taskIds.push(taskId);
        const skills = parseArray<string>(draft.skill_ids).filter((value) => skillIds.has(value));
        await tx.$executeRawUnsafe(
          `INSERT INTO tasks (id, group_id, parent_task_id, sort_order, type, title, description, status, priority, skills, breakdown_session_id)
           VALUES (?, ?, ?, ?, '子任务', ?, ?, 'BACKLOG', ?, ?, ?)`,
          taskId,
          session.group_id ?? DEFAULT_GROUP_ID,
          parentTaskId,
          draft.sort_order ?? 0,
          draft.title,
          draft.description,
          draft.priority ?? 3,
          JSON.stringify(skills),
          sessionId,
        );
        await this.audit.record(
          {
            actorType: 'user',
            action: 'task_create',
            targetType: 'task',
            targetId: taskId,
            after: { id: taskId, type: '子任务', title: draft.title, parent: parentTaskId },
          },
          tx,
        );
      }

      // 依赖边批量建立：草案间的 ref 依赖映射成新任务 id 的 blocks 边。
      for (const draft of drafts) {
        for (const depRef of parseArray<string>(draft.depends_on)) {
          const dependsOn = refToTask.get(depRef);
          if (!dependsOn) continue;
          await tx.$executeRawUnsafe(
            `INSERT INTO task_dependencies (id, task_id, depends_on, type) VALUES (?, ?, ?, 'blocks')`,
            newId(),
            refToTask.get(draft.ref)!,
            dependsOn,
          );
        }
      }

      await tx.$executeRawUnsafe(
        `UPDATE breakdown_sessions SET status = 'completed', confirmed_at = datetime('now'), parent_task_id = ? WHERE id = ?`,
        parentTaskId,
        sessionId,
      );
      await this.audit.record(
        {
          actorType: 'user',
          action: 'breakdown_confirm',
          targetType: 'breakdown_session',
          targetId: sessionId,
          after: { parent_task_id: parentTaskId, task_ids: taskIds },
        },
        tx,
      );
      return { parentTaskId, taskIds };
    });

    // §8.6：拆解确认建的任务按 user 来源广播（origin_type 与落库默认列一致）。
    this.events.emit('task.created', { id: created.parentTaskId, origin_type: 'user' });
    for (const taskId of created.taskIds)
      this.events.emit('task.created', { id: taskId, origin_type: 'user' });
    return {
      session: await this.requireSession(sessionId),
      parent_task_id: created.parentTaskId,
      task_ids: created.taskIds,
    };
  }

  // ------------------------------------------- W7 遗留 b3：确认页草案编辑（§7.4，UI 面）

  /**
   * §7.4「添加任务」用户侧写入口：与 Agent 面 reportDraft 同表同约束
   * （UNIQUE(session_id, ref)、priority 0~3、ref 自环/未知前置/成环一律拒），
   * 差别只在守卫状态——reportDraft 要 receiving（#34 后仅再放行「重新生成」哨兵草案的
   * 重报），这里要 reviewing（§7.7 待确认期编辑）。
   * ref 可省略：服务端按会话内数字后缀取号 t{max+1}；显式传的 ref 已被占用 →
   * 409 BREAKDOWN_DRAFT_REF_TAKEN。
   */
  async userAddDraft(sessionId: string, input: Partial<BreakdownDraftInput>): Promise<DraftDtoShape[]> {
    const session = await this.requireSession(sessionId);
    this.assertStatus(session, 'reviewing', ['reviewing']);
    const existing = await this.drafts(sessionId);
    const ref = input.ref?.trim() ? text(input.ref, 'ref') : nextUserRef(existing);
    if (existing.some((draft) => draft.ref === ref)) {
      throw new ApiException('BREAKDOWN_DRAFT_REF_TAKEN', `草案引用 ${ref} 在会话内已存在`, undefined, {
        session_id: sessionId,
        ref,
      });
    }
    const title = text(input.title ?? '新任务', 'title');
    const priority = input.priority ?? 3;
    assertPriority(priority, sessionId);
    const dependsOn = normalizeRefs(input.depends_on, 'depends_on');
    if (dependsOn.includes(ref)) {
      throw new ApiException('DEPENDENCY_CYCLE', '草案不能依赖自身');
    }
    this.assertProspectiveGraph(existing, ref, dependsOn, sessionId);
    const skillIds = normalizeRefs(input.skill_ids, 'skill_ids');
    const acceptance = toStringArray(input.acceptance ?? [], 'acceptance').map((v) => v.trim()).filter(Boolean);
    const sortOrder = input.sort_order ?? existing.reduce((max, d) => Math.max(max, d.sort_order ?? 0), -1) + 1;

    await this.prisma.$transaction(async (tx) => {
      this.assertReviewingGuard(await guardReviewingUpdate(tx, sessionId));
      await tx.$executeRawUnsafe(
        `INSERT INTO breakdown_drafts (id, session_id, ref, title, description, priority, skill_ids, acceptance, depends_on, sort_order)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        newId(),
        sessionId,
        ref,
        title,
        input.description ?? null,
        priority,
        JSON.stringify(skillIds),
        JSON.stringify(acceptance),
        JSON.stringify(dependsOn),
        sortOrder,
      );
      await recountActualTasks(tx, sessionId);
    });
    this.events.emit('breakdown.task_draft', { session_id: sessionId, ref });
    return (await this.drafts(sessionId)).map(toDraftDto);
  }

  /**
   * §7.4 局部更新（标题/描述/优先级/技能/验收/依赖）+ 条款 81「歧义候选重选=可改」：
   * skill_ids/depends_on 传了即整体替换。仅 reviewing 可写；depends_on 变化后按
   *  prospective 图查自环/未知 ref/成环（服务端兜底 §7.8，前端拦截只是体验层）。
   */
  async userUpdateDraft(
    sessionId: string,
    ref: string,
    patch: Partial<BreakdownDraftInput>,
  ): Promise<DraftDtoShape[]> {
    const session = await this.requireSession(sessionId);
    this.assertStatus(session, 'reviewing', ['reviewing']);
    const existing = await this.drafts(sessionId);
    const row = existing.find((draft) => draft.ref === ref);
    if (!row) throw draftNotFound(sessionId, ref);
    if (patch.priority !== undefined) assertPriority(patch.priority, sessionId);
    if (patch.depends_on !== undefined) {
      const nextDeps = normalizeRefs(patch.depends_on, 'depends_on');
      if (nextDeps.includes(ref)) {
        throw new ApiException('DEPENDENCY_CYCLE', '草案不能依赖自身');
      }
      this.assertProspectiveGraph(existing, ref, nextDeps, sessionId);
    }

    // depends_on 未显式改动时：若行上挂着「待重新生成」哨兵（JSON 对象，
    // parseArray 会误吞成 []），原样保留——改标题/描述不该悄悄清除待重报态。
    const nextDependsOn =
      patch.depends_on === undefined
        ? hasRegenerationFlag(row.depends_on)
          ? (row.depends_on as string)
          : JSON.stringify(parseArray<string>(row.depends_on))
        : JSON.stringify(normalizeRefs(patch.depends_on, 'depends_on'));
    const next = {
      title: patch.title === undefined ? row.title : text(patch.title, 'title'),
      description: patch.description === undefined ? row.description : patch.description,
      priority: patch.priority ?? row.priority ?? 3,
      skill_ids: JSON.stringify(
        patch.skill_ids === undefined
          ? parseArray<string>(row.skill_ids)
          : normalizeRefs(patch.skill_ids, 'skill_ids'),
      ),
      acceptance: JSON.stringify(
        patch.acceptance === undefined
          ? parseArray<string>(row.acceptance)
          : toStringArray(patch.acceptance, 'acceptance').map((v) => v.trim()).filter(Boolean),
      ),
      depends_on: nextDependsOn,
      sort_order: patch.sort_order ?? row.sort_order ?? 0,
    };
    await this.prisma.$transaction(async (tx) => {
      this.assertReviewingGuard(await guardReviewingUpdate(tx, sessionId));
      await tx.$executeRawUnsafe(
        `UPDATE breakdown_drafts
            SET title = ?, description = ?, priority = ?, skill_ids = ?, acceptance = ?, depends_on = ?, sort_order = ?
          WHERE id = ?`,
        next.title,
        next.description,
        next.priority,
        next.skill_ids,
        next.acceptance,
        next.depends_on,
        next.sort_order,
        row.id,
      );
    });
    this.events.emit('breakdown.task_draft', { session_id: sessionId, ref });
    return (await this.drafts(sessionId)).map(toDraftDto);
  }

  /**
   * §7.4「删除任务」：删行 + 级联清其它草案 depends_on 里的悬空引用（同事务），
   * 与 confirm 侧 assertDraftGraph 的「前置不存在即拒」口径对齐，不留幽灵边。
   */
  async userDeleteDraft(sessionId: string, ref: string): Promise<DraftDtoShape[]> {
    const session = await this.requireSession(sessionId);
    this.assertStatus(session, 'reviewing', ['reviewing']);
    const existing = await this.drafts(sessionId);
    const row = existing.find((draft) => draft.ref === ref);
    if (!row) throw draftNotFound(sessionId, ref);
    const dependents = existing.filter((draft) => draft.ref !== ref && parseArray<string>(draft.depends_on).includes(ref));

    await this.prisma.$transaction(async (tx) => {
      this.assertReviewingGuard(await guardReviewingUpdate(tx, sessionId));
      await tx.$executeRawUnsafe(`DELETE FROM breakdown_drafts WHERE id = ?`, row.id);
      for (const draft of dependents) {
        const cleaned = parseArray<string>(draft.depends_on).filter((dep) => dep !== ref);
        await tx.$executeRawUnsafe(
          `UPDATE breakdown_drafts SET depends_on = ? WHERE id = ?`,
          JSON.stringify(cleaned),
          draft.id,
        );
      }
      await recountActualTasks(tx, sessionId);
    });
    this.events.emit('breakdown.task_draft', { session_id: sessionId, ref });
    return (await this.drafts(sessionId)).map(toDraftDto);
  }

  /**
   * §7.4「重新生成」（条款 81 补齐）：重置该草案待 Agent 重报——title 置占位、
   * description/skill_ids/acceptance 清空，depends_on 列改存「待重报」哨兵（见
   * REGENERATION_PLACEHOLDER_TITLE 注释）。priority/sort_order 属用户在确认页
   * 可调的排布字段，原样保留。仅 reviewing 可写，并发守卫与其余写端点同款；
   * 广播既有 `breakdown.task_draft` 事件，读侧回 GET 拿真相。
   * #34 配对：哨兵在位时 Agent 可用 `board.report_task_draft` 重报该 ref，整行覆盖后
   * 哨兵消失；用户在确认页上的其余编辑不受影响。
   */
  async userRegenerateDraft(sessionId: string, ref: string): Promise<DraftDtoShape[]> {
    const session = await this.requireSession(sessionId);
    this.assertStatus(session, 'reviewing', ['reviewing']);
    const existing = await this.drafts(sessionId);
    const row = existing.find((draft) => draft.ref === ref);
    if (!row) throw draftNotFound(sessionId, ref);

    await this.prisma.$transaction(async (tx) => {
      this.assertReviewingGuard(await guardReviewingUpdate(tx, sessionId));
      await tx.$executeRawUnsafe(
        `UPDATE breakdown_drafts
            SET title = ?, description = NULL, skill_ids = '[]', acceptance = '[]', depends_on = ?
          WHERE id = ?`,
        REGENERATION_PLACEHOLDER_TITLE,
        regenerationFlagJson(),
        row.id,
      );
    });
    this.events.emit('breakdown.task_draft', { session_id: sessionId, ref });
    return (await this.drafts(sessionId)).map(toDraftDto);
  }

  // ---------------------------------------------------------------- 取消与读侧

  async cancel(sessionId: string): Promise<SessionDtoShape> {
    const session = await this.requireSession(sessionId);
    this.assertStatus(session, 'receiving 或 reviewing', ['receiving', 'reviewing']);
    await this.prisma.$executeRawUnsafe(
      `UPDATE breakdown_sessions SET status = 'cancelled', cancelled_at = datetime('now') WHERE id = ?`,
      sessionId,
    );
    await this.audit.record({
      actorType: 'user',
      action: 'breakdown_cancel',
      targetType: 'breakdown_session',
      targetId: sessionId,
      before: { status: session.status },
    });
    this.events.emit('breakdown.cancelled', { session_id: sessionId });
    return this.requireSession(sessionId);
  }

  async get(sessionId: string): Promise<BreakdownSessionDetail> {
    const session = await this.requireSession(sessionId);
    const drafts = await this.drafts(sessionId);
    const progress = await this.prisma.$queryRawUnsafe<ProgressRow[]>(
      `SELECT id, step, total, message, created_at FROM breakdown_progress WHERE session_id = ? ORDER BY id`,
      sessionId,
    );
    // 条款 81：finish 算出的技能解析报告不再只留在响应里——GET 逐条草案透出解析态，
    // 确认页（session 详情即数据源）可见可改。finish 后草案存的是解析出的 id，同名歧义
    // 按「该 id 的技能名是否多技能共用」复原，标注不会因落库转 id 而丢失。
    const annotated = await this.annotateSkills(drafts);
    return {
      session,
      drafts: drafts.map((draft, index) => ({ ...toDraftDto(draft), skills_status: annotated.perDraft[index] })),
      progress: progress.map((row) => ({
        id: row.id,
        step: row.step,
        total: row.total,
        message: row.message,
        created_at: row.created_at,
      })),
      skill_resolution: annotated.report,
    };
  }

  async list(): Promise<SessionDtoShape[]> {
    const rows = await this.prisma.$queryRawUnsafe<SessionRow[]>(
      `SELECT ${SESSION_COLUMNS} FROM breakdown_sessions ORDER BY created_at DESC, id DESC`,
    );
    return rows.map(toSessionDto);
  }

  // ---------------------------------------------------------------- 守卫与内部件

  async requireSession(id: string): Promise<SessionDtoShape> {
    const rows = await this.prisma.$queryRawUnsafe<SessionRow[]>(
      `SELECT ${SESSION_COLUMNS} FROM breakdown_sessions WHERE id = ?`,
      id,
    );
    const row = rows[0];
    if (!row) throw new ApiException('NOT_FOUND', '拆解会话不存在', undefined, { session_id: id });
    return toSessionDto(row);
  }

  /** §7.7：动作只允许从指定状态出发；表外状态统一 BREAKDOWN_BAD_STATE（409）。 */
  private assertStatus(session: SessionDtoShape, required: string, allowed: BreakdownSessionStatus[]): void {
    if (!allowed.includes(session.status as BreakdownSessionStatus)) {
      throw new ApiException(
        'BREAKDOWN_BAD_STATE',
        `拆解会话当前状态「${session.status}」不允许该操作（需要：${required}）`,
        undefined,
        { session_id: session.id, status: session.status, allowed },
      );
    }
  }

  /** §7.8 依赖成环→拒绝：草案 ref 图（confirm 时可能被页面编辑过，finish/confirm 两侧都查）。 */
  private assertDraftGraph(drafts: DraftRow[], sessionId: string): void {
    const refs = new Set(drafts.map((d) => d.ref));
    for (const draft of drafts) {
      for (const dep of parseArray<string>(draft.depends_on)) {
        if (!refs.has(dep)) {
          throw new ApiException('VALIDATION_FAILED', `草案 ${draft.ref} 的前置 ${dep} 不存在`, undefined, {
            session_id: sessionId,
            ref: draft.ref,
            unknown_ref: dep,
          });
        }
      }
    }
    const edges = new Map(drafts.map((d) => [d.ref, parseArray<string>(d.depends_on)]));
    const state = new Map<string, 'visiting' | 'done'>();
    const path: string[] = [];
    const walk = (ref: string): void => {
      const mark = state.get(ref);
      if (mark === 'done') return;
      if (mark === 'visiting') {
        const chain = [...path.slice(path.indexOf(ref)), ref].join(' → ');
        throw new ApiException('DEPENDENCY_CYCLE', `拆解草案依赖形成环：${chain}，已拒绝`, undefined, {
          session_id: sessionId,
          chain: chain.split(' → '),
        });
      }
      state.set(ref, 'visiting');
      path.push(ref);
      for (const dep of edges.get(ref) ?? []) walk(dep);
      path.pop();
      state.set(ref, 'done');
    };
    for (const draft of drafts) walk(draft.ref);
  }

  /**
   * §7.5 技能解析闭环：值已是技能 id 直通；否则按 name 精确匹配——
   * 唯一命中→转 id；同名多技能→取 updatedAt 最近者并记 ambiguous；无命中→记 unresolved、草案保留原值。
   */
  private async resolveSkills(
    drafts: DraftRow[],
  ): Promise<{ report: SkillResolutionReport; updated: { id: string; skillIds: string[] }[] }> {
    const values = [...new Set(drafts.flatMap((d) => parseArray<string>(d.skill_ids)))];
    const report: SkillResolutionReport = { ambiguous: [], unresolved: [] };
    const updated: { id: string; skillIds: string[] }[] = [];
    if (values.length === 0) return { report, updated };

    const idRows = await this.prisma.$queryRawUnsafe<{ id: string }[]>(
      `SELECT id FROM skills WHERE id IN (${placeholders(values.length)})`,
      ...values,
    );
    const knownIds = new Set(idRows.map((row) => row.id));
    const names = values.filter((value) => !knownIds.has(value));
    const byName = new Map<string, { id: string }[]>();
    if (names.length > 0) {
      // 「最近更新者」：datetime('now') 秒级精度下并列时按 UUIDv7 大者（后创建=时间序更大）。
      const hits = await this.prisma.$queryRawUnsafe<{ id: string; name: string }[]>(
        `SELECT id, name FROM skills WHERE name IN (${placeholders(names.length)}) ORDER BY updated_at DESC, id DESC`,
        ...names,
      );
      for (const hit of hits) {
        const list = byName.get(hit.name) ?? [];
        list.push({ id: hit.id });
        byName.set(hit.name, list);
      }
    }

    for (const draft of drafts) {
      const raw = parseArray<string>(draft.skill_ids);
      if (raw.length === 0) continue;
      let changed = false;
      const resolved = raw.map((value) => {
        if (knownIds.has(value)) return value;
        const hits = byName.get(value) ?? [];
        if (hits.length === 0) {
          report.unresolved.push({ ref: draft.ref, name: value });
          return value;
        }
        changed = true;
        if (hits.length > 1) {
          report.ambiguous.push({
            ref: draft.ref,
            name: value,
            skill_id: hits[0]!.id,
            candidates: hits.map((h) => h.id),
          });
        }
        return hits[0]!.id;
      });
      if (changed) updated.push({ id: draft.id, skillIds: dedupe(resolved) });
    }
    return { report, updated };
  }

  /**
   * 条款 81：GET 读侧的技能解析标注——与 resolveSkills 同一判据（id 直通、name 精确匹配、
   * 同名多技能按「最近更新者」序），但纯读零副作用。finish 之后草案里存的是落定 id，
   * 「同名歧义」经该 id 技能名的共用者复原，保证确认页在 finish 前后都看得到标注。
   */
  private async annotateSkills(
    drafts: DraftRow[],
  ): Promise<{ perDraft: SkillStatusEntry[][]; report: SkillResolutionReport }> {
    const values = [...new Set(drafts.flatMap((d) => parseArray<string>(d.skill_ids)))];
    const info = new Map<string, SkillStatusEntry>();
    if (values.length > 0) {
      const idHits = await this.prisma.$queryRawUnsafe<{ id: string; name: string }[]>(
        `SELECT id, name FROM skills WHERE id IN (${placeholders(values.length)})`,
        ...values,
      );
      const idName = new Map(idHits.map((row) => [row.id, row.name]));
      // 非 id 的值按候选名查；命中的 id 用其技能名查「同名亲族」——一张查询表覆盖两种歧义。
      const nameKeys = [...new Set([...idName.values(), ...values.filter((value) => !idName.has(value))])];
      const byName = new Map<string, string[]>();
      if (nameKeys.length > 0) {
        const hits = await this.prisma.$queryRawUnsafe<{ id: string; name: string }[]>(
          `SELECT id, name FROM skills WHERE name IN (${placeholders(nameKeys.length)}) ORDER BY updated_at DESC, id DESC`,
          ...nameKeys,
        );
        for (const hit of hits) {
          const list = byName.get(hit.name) ?? [];
          list.push(hit.id);
          byName.set(hit.name, list);
        }
      }
      for (const value of values) {
        const ownName = idName.get(value);
        if (ownName) {
          const group = byName.get(ownName) ?? [value];
          info.set(value, {
            value,
            state: group.length > 1 ? 'ambiguous' : 'resolved',
            skill_id: value,
            name: ownName,
            candidates: group,
          });
          continue;
        }
        const hits = byName.get(value) ?? [];
        info.set(value,
          hits.length === 0
            ? { value, state: 'unresolved', skill_id: null, name: value, candidates: [] }
            : {
                value,
                state: hits.length > 1 ? 'ambiguous' : 'resolved',
                skill_id: hits[0]!,
                name: value,
                candidates: hits,
              },
        );
      }
    }
    const report: SkillResolutionReport = { ambiguous: [], unresolved: [] };
    const perDraft = drafts.map((draft) => {
      const statuses = parseArray<string>(draft.skill_ids).flatMap((value) => {
        const entry = info.get(value);
        if (!entry) return [];
        if (entry.state === 'ambiguous') {
          report.ambiguous.push({ ref: draft.ref, name: entry.name, skill_id: entry.skill_id!, candidates: entry.candidates });
        } else if (entry.state === 'unresolved') {
          report.unresolved.push({ ref: draft.ref, name: value });
        }
        return [entry];
      });
      return statuses;
    });
    return { perDraft, report };
  }

  /** §7.7：status 条件 UPDATE 命中 0 行＝写事务开始时会话已不在 reviewing（confirm/超时收敛抢先），统一 409。 */
  private assertReviewingGuard(affected: number): void {
    if (affected === 0) {
      throw new ApiException(
        'BREAKDOWN_BAD_STATE',
        '拆解会话已离开待确认状态，草案写入被拒绝（§7.7 仅 reviewing 可编辑）',
        undefined,
        { allowed: ['reviewing'] },
      );
    }
  }

  /** §7.8 成环/自引用兜底：把 ref 的依赖边集合替换成候选值后跑同一张图检查（含未知前置）。 */
  private assertProspectiveGraph(existing: DraftRow[], ref: string, nextDeps: string[], sessionId: string): void {
    const prospective = existing.map((draft) =>
      draft.ref === ref ? { ...draft, depends_on: JSON.stringify(nextDeps) } : draft,
    );
    if (!prospective.some((draft) => draft.ref === ref)) {
      prospective.push({
        id: `pending-${ref}`,
        session_id: sessionId,
        ref,
        title: '',
        description: null,
        priority: null,
        skill_ids: '[]',
        acceptance: '[]',
        depends_on: JSON.stringify(nextDeps),
        sort_order: null,
      });
    }
    this.assertDraftGraph(prospective, sessionId);
  }

  private async drafts(sessionId: string): Promise<DraftRow[]> {
    return this.prisma.$queryRawUnsafe<DraftRow[]>(
      `SELECT id, session_id, ref, title, description, priority, skill_ids, acceptance, depends_on, sort_order
         FROM breakdown_drafts WHERE session_id = ? ORDER BY sort_order ASC, ref ASC`,
      sessionId,
    );
  }

  /** 与 TasksService.assertGroup 同口径：不存在的组 404，归档组只读 409。 */
  private async assertActiveGroup(groupId: string): Promise<void> {
    const rows = await this.prisma.$queryRawUnsafe<{ id: string; status: string; name: string }[]>(
      `SELECT id, status, name FROM groups WHERE id = ?`,
      groupId,
    );
    const group = rows[0];
    if (!group) throw new ApiException('NOT_FOUND', `分组 ${groupId} 不存在`);
    if (group.status === 'ARCHIVED') {
      throw new ApiException('GROUP_ARCHIVED', `分组「${group.name}」已归档，只读`, undefined, { group_id: group.id });
    }
  }
}

export type SessionDtoShape = Omit<SessionRow, 'status'> & { status: BreakdownSessionStatus };

export interface DraftDtoShape {
  id: string;
  ref: string;
  title: string;
  description: string | null;
  priority: number;
  skill_ids: string[];
  acceptance: string[];
  depends_on: string[];
  sort_order: number;
  /** 条款 81：仅 GET 详情填充（reportDraft 的即时回显不含读侧标注）。 */
  skills_status?: SkillStatusEntry[];
  /** §7.4「重新生成」：草案已重置、待 Agent 重报。仅置真时出现（旧消费者零扰动）。 */
  regeneration_pending?: boolean;
}

/** GET 载荷里每条草案技能值的解析态（resolved id / ambiguous 候选列表 / unresolved 原样保留）。 */
export interface SkillStatusEntry {
  /** 草案里存的原值（finish 后为落定 id，未解析时仍是 Agent 上报的名字）。 */
  value: string;
  state: 'resolved' | 'ambiguous' | 'unresolved';
  /** 解析落定的技能 id；unresolved 为 null。 */
  skill_id: string | null;
  /** 命中的技能名；unresolved 时即原值。 */
  name: string;
  /** 同名全部技能 id（含落定者，「最近更新者」在前）；resolved 单命中时即 [skill_id]。 */
  candidates: string[];
}

export interface BreakdownSessionDetail {
  session: SessionDtoShape;
  drafts: DraftDtoShape[];
  progress: { id: number; step: number; total: number; message: string | null; created_at: string }[];
  /** 与 finish 响应同形状的汇总报告（确认页告警条用；逐条状态见 drafts[].skills_status）。 */
  skill_resolution: SkillResolutionReport;
}

interface ProgressRow {
  id: number;
  step: number;
  total: number;
  message: string | null;
  created_at: string;
}

function toSessionDto(row: SessionRow): SessionDtoShape {
  return { ...row, status: row.status as BreakdownSessionStatus };
}

function toDraftDto(row: DraftRow): DraftDtoShape {
  const dto: DraftDtoShape = {
    id: row.id,
    ref: row.ref,
    title: row.title,
    description: row.description,
    priority: row.priority ?? 3,
    skill_ids: parseArray<string>(row.skill_ids),
    acceptance: parseArray<string>(row.acceptance),
    depends_on: parseArray<string>(row.depends_on),
    sort_order: row.sort_order ?? 0,
  };
  if (hasRegenerationFlag(row.depends_on)) dto.regeneration_pending = true;
  return dto;
}

/**
 * §7.4「重新生成」哨兵（条款 81 补齐）：纯本地架构服务端回调不了 Agent，
 * 「重新生成」= 把草案重置为**待 Agent 重报**。「待重报」状态存进 depends_on 列的
 * JSON 对象 `{"regeneration_pending":true}`——parseArray 对非数组一律回 []，
 * finish/confirm/读侧全部自然降级为「无依赖」，零 Prisma 迁移。
 */
const REGENERATION_PLACEHOLDER_TITLE = '（待重新生成）';

function regenerationFlagJson(): string {
  return JSON.stringify({ regeneration_pending: true });
}

function hasRegenerationFlag(json: string | null): boolean {
  if (!json) return false;
  try {
    const value: unknown = JSON.parse(json);
    return typeof value === 'object' && value !== null && (value as { regeneration_pending?: unknown }).regeneration_pending === true;
  } catch {
    return false;
  }
}

function parseArray<T>(json: string | null): T[] {
  if (!json) return [];
  try {
    const value: unknown = JSON.parse(json);
    return Array.isArray(value) ? (value as T[]) : [];
  } catch {
    return [];
  }
}

function unionSkillRefs(drafts: DraftRow[]): string[] {
  return [...new Set(drafts.flatMap((d) => parseArray<string>(d.skill_ids)))];
}

function placeholders(count: number): string {
  return Array.from({ length: count }, () => '?').join(',');
}

function dedupe(values: string[]): string[] {
  return [...new Set(values)];
}

function text(value: string, field: string): string {
  const trimmed = typeof value === 'string' ? value.trim() : '';
  if (!trimmed) {
    throw new ApiException('VALIDATION_FAILED', `${field} 不能为空`, [{ path: field, code: 'too_small', message: '必填' }]);
  }
  return trimmed;
}

// ------------------------------------------- W7 遗留 b3：用户侧草案写端点的内部件

/**
 * 并发守卫（b2e97c2 confirm 的状态条件 UPDATE 同款）：'reviewing' 判定与后续写在
 * 同一事务里原子命中；返回 0 行即别的动作（confirm / 超时收敛）已抢先流转。
 */
async function guardReviewingUpdate(tx: Prisma.TransactionClient, sessionId: string): Promise<number> {
  return tx.$executeRawUnsafe(
    `UPDATE breakdown_sessions SET status = 'reviewing' WHERE id = ? AND status = 'reviewing'`,
    sessionId,
  );
}

/** 草案增删后同步 actual_tasks（与 finish 口径一致，确认页计数不漂移）。 */
async function recountActualTasks(tx: Prisma.TransactionClient, sessionId: string): Promise<void> {
  await tx.$executeRawUnsafe(
    `UPDATE breakdown_sessions SET actual_tasks = (SELECT COUNT(*) FROM breakdown_drafts WHERE session_id = ?) WHERE id = ?`,
    sessionId,
    sessionId,
  );
}

/** 与 web draft-edit.ts 的 nextDraftRef 同口径：数字后缀最大值 +1，无草案回 t1。 */
function nextUserRef(drafts: DraftRow[]): string {
  let max = 0;
  for (const draft of drafts) {
    const n = Number.parseInt(draft.ref.replace(/^\D+/, ''), 10);
    if (Number.isFinite(n)) max = Math.max(max, n);
  }
  return `t${max + 1}`;
}

function assertPriority(priority: number, sessionId: string): void {
  if (!Number.isInteger(priority) || priority < 0 || priority > 3) {
    throw new ApiException('VALIDATION_FAILED', 'priority 取值 0~3（20 章）', undefined, { session_id: sessionId });
  }
}

function toStringArray(value: unknown, field: string): string[] {
  if (!Array.isArray(value) || value.some((item) => typeof item !== 'string')) {
    throw new ApiException('VALIDATION_FAILED', `${field} 必须是字符串数组`, [{ path: field, code: 'invalid_type', message: 'string[]' }]);
  }
  return value as string[];
}

/** ref / skill_ids 一类字符串数组入参：逐项 trim + 会话内去重，空值即 422。 */
function normalizeRefs(values: string[] | undefined, field: string): string[] {
  return dedupe(toStringArray(values ?? [], field).map((value) => text(value, field)));
}

function draftNotFound(sessionId: string, ref: string): ApiException {
  return new ApiException('NOT_FOUND', `会话内不存在草案 ${ref}`, undefined, { session_id: sessionId, ref });
}

function assertEstimated(value: number): void {
  if (!Number.isInteger(value) || value < 1) {
    throw new ApiException('VALIDATION_FAILED', 'estimated_tasks 须为正整数', [
      { path: 'estimated_tasks', code: 'too_small', message: '≥ 1' },
    ]);
  }
}
