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
import { SettingsService } from '../infra/settings.service';

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

/**
 * #4 会话列表过滤与分页（GET /breakdown/sessions 的 query 入参）。
 * `scope` 缺省 all（保持旧调用兼容）；`include_archived` 默认 false；
 * `cursor` 是上一页最后一条的会话 id（keyset 分页，按 created_at DESC, id DESC）。
 */
export interface BreakdownListQuery {
  scope?: 'active' | 'history' | 'all';
  include_archived?: boolean;
  requirement_id?: string;
  limit?: number;
  cursor?: string;
}

/**
 * #4 `board.wait_for_breakdown` 的返回。Agent 依据 action 决定下一步：
 * draft_regenerate / session_regenerate 要重报草案，user_edited 只读最新内容，
 * confirmed / cancelled / interrupted 结束，timeout 带 revision 续等。
 */
export interface BreakdownWaitResult {
  session_id: string;
  status: BreakdownSessionStatus;
  revision: number;
  changed: boolean;
  action:
    | 'draft_regenerate'
    | 'session_regenerate'
    | 'user_edited'
    | 'reviewing'
    | 'receiving'
    | 'confirmed'
    | 'cancelled'
    | 'interrupted'
    | 'timeout';
  refs: string[];
  note: string | null;
  notes: { ref: string; note: string | null; requested_at: string | null }[];
  /** 中文一句话，告诉 Agent 下一步怎么做。 */
  message: string;
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
  /** #4：每次「重新生成」+1（0=从未），与 note/requested_at 配对供确认页与审计使用。 */
  revision: number;
  revision_note: string | null;
  revision_requested_at: string | null;
  /** #4 列表过滤用派生列：父需求任务被归档时非空（无父任务/未归档均为 NULL）。 */
  parent_archived_at?: string | null;
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
  /** 历史行可能仍是旧哨兵对象 `{"regeneration_pending":true}`（只读兼容）；新写入恒为 string[]。 */
  depends_on: string | null;
  /** #4：显式重生成列（0024）；旧库哨兵行由读路径兼容，不保证本列为 1。 */
  regeneration_pending: number;
  regeneration_note: string | null;
  regeneration_requested_at: string | null;
  sort_order: number | null;
}

const SESSION_COLUMNS = `
  id, requirement_text, group_id, parent_title, parent_description, parent_task_id,
  status, agent_name, skill_used, estimated_tasks, actual_tasks,
  revision, revision_note, revision_requested_at,
  (SELECT archived_at FROM tasks WHERE tasks.id = breakdown_sessions.parent_task_id) AS parent_archived_at,
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
    private readonly settings: SettingsService,
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
    // #4：进度上报也算会话内容变化——写入流水与 revision+1 同事务，避免「进度落了、修订号没动」。
    await this.prisma.$transaction(async (tx) => {
      await tx.$executeRawUnsafe(
        `INSERT INTO breakdown_progress (session_id, step, total, message) VALUES (?, ?, ?, ?)`,
        sessionId,
        input.step,
        input.total,
        input.message ?? null,
      );
      await tx.$executeRawUnsafe(
        `UPDATE breakdown_sessions SET revision = revision + 1 WHERE id = ?`,
        sessionId,
      );
    });
    this.events.emit('breakdown.progress', { session_id: sessionId, step: input.step, total: input.total });
  }

  /**
   * 同 (session_id, ref) 再上报即整体覆盖（§7.6 UNIQUE；阶段 4 允许 Agent 修订草案）。
   *
   * 守卫（工单 #34 B 口径）：会话 receiving 照旧；reviewing 只放行「被重新生成」的那条
   * 草案——即 §7.4 用户点了「重新生成」、行上挂着 regeneration_pending（显式列；旧库
   * 行兼容 depends_on JSON 哨兵）、正等 Agent 重报的 ref。待重报草案本就是空壳（title
   * 占位、描述/技能/验收全清），覆盖它不碰人工编辑成果；其余 reviewing 期重报（无待重报
   * 标记的新旧 ref）仍 409，终态一律不变。
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
    // #4：整行覆盖时显式清零重生成三列——Agent 重报即「销账」，单草案与会话级重生成同法。
    const sql = `INSERT INTO breakdown_drafts (id, session_id, ref, title, description, priority, skill_ids, acceptance, depends_on, sort_order)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(session_id, ref) DO UPDATE SET
         title = excluded.title, description = excluded.description, priority = excluded.priority,
         skill_ids = excluded.skill_ids, acceptance = excluded.acceptance,
         depends_on = excluded.depends_on, sort_order = excluded.sort_order,
         regeneration_pending = 0, regeneration_note = NULL, regeneration_requested_at = NULL`;
    if (regenerationReplay) {
      // 重报与用户侧写端点同款并发守卫：'reviewing' 判定与写在同一事务原子命中，
      // 抢先流转（confirm / 超时收敛）即 409，不给「已确认的会话」补草案。
      // guardReviewingUpdate 自带 revision+1，#4 不再二次递增。
      await this.prisma.$transaction(async (tx) => {
        this.assertReviewingGuard(await guardReviewingUpdate(tx, sessionId));
        await tx.$executeRawUnsafe(sql, ...values);
      });
    } else {
      // #4：receiving 正常上报（含同 ref 覆盖）也是内容变化——upsert 与 revision+1 同事务。
      await this.prisma.$transaction(async (tx) => {
        await tx.$executeRawUnsafe(sql, ...values);
        await tx.$executeRawUnsafe(
          `UPDATE breakdown_sessions SET revision = revision + 1 WHERE id = ?`,
          sessionId,
        );
      });
    }
    const row = await this.drafts(sessionId);
    const dto = toDraftDto(row.find((d) => d.ref === ref)!);
    this.events.emit('breakdown.task_draft', { session_id: sessionId, ref });
    return dto;
  }

  /**
   * #34：本条上报是否属于「重报被重新生成的草案」。仅 reviewing + 该 ref 已存在且
   * 挂着待重报标记（0024 显式列 regeneration_pending=1；旧库行仍认 depends_on JSON
   * 哨兵）时为真；ref 空白/未知/无标记一律假（调用方据此回落到原 409 守卫，
   * reviewing 期新增 ref 依旧被拒）。
   */
  private async isRegenerationReplay(session: SessionDtoShape, rawRef: string): Promise<boolean> {
    if (session.status !== 'reviewing') return false;
    const ref = typeof rawRef === 'string' ? rawRef.trim() : '';
    if (!ref) return false;
    const row = (await this.drafts(session.id)).find((draft) => draft.ref === ref);
    return row !== undefined && isRegenerationPending(row);
  }

  /**
   * #34：重报待重生成草案时就地跑 §7.5 解析——复用 resolveSkills 的同一判据（id 直通、
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
        regeneration_pending: 0,
        regeneration_note: null,
        regeneration_requested_at: null,
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

    // #4：会话级重生成后存在未重报草案时，finish 必须硬性拦住——否则 Agent 可无视
    // 用户的「整份重新生成」直接收尾，旧草案被剪成空会话，用户的请求被静默吞掉。
    // Agent 必须先逐条重报 refs（新方案想换 ref，也需把旧 ref 全部重报销账）。
    this.assertNoPendingRegeneration(drafts, sessionId);

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
        `UPDATE breakdown_sessions
            SET status = 'reviewing', finished_at = datetime('now'), actual_tasks = ?, revision = revision + 1
          WHERE id = ?`,
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
    // #4：单草案重生成后 Agent 未重报时，确认必须被硬性拦住——空壳草案建出来的任务
    // 只有占位标题，等于把用户的「重新生成」静默吞掉。
    this.assertNoPendingRegeneration(drafts, sessionId);
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

    // 0020 草案 §3.1 + 2026-09-28 用户拍板：拆解建的父单与子任务同样吃全局默认键
    // `default_review_mode`——三条建单路（REST 人建、MCP 直建、拆解）口径必须一致，
    // 否则用户在设置页选了 auto，Agent 拆出来的子任务还是全部堆在人工待审列。
    // 必须在事务**外**取：settings 走的是主连接，SQLite 的写事务持锁期间跨连接读会阻塞到超时。
    const reviewMode = await this.settings.resolveReviewMode();

    const created = await this.prisma.$transaction(async (tx) => {
      const parentTaskId = await nextTaskId(tx);
      await tx.$executeRawUnsafe(
        `INSERT INTO tasks (id, group_id, type, title, description, status, priority, skills, breakdown_session_id, review_mode)
         VALUES (?, ?, '需求', ?, ?, 'BACKLOG', 3, '[]', ?, ?)`,
        parentTaskId,
        session.group_id ?? DEFAULT_GROUP_ID,
        session.parent_title,
        session.parent_description,
        sessionId,
        reviewMode,
      );

      const refToTask = new Map<string, string>();
      const taskIds: string[] = [];
      for (const draft of drafts) {
        const taskId = await nextTaskId(tx);
        refToTask.set(draft.ref, taskId);
        taskIds.push(taskId);
        const skills = parseSkillIdsColumn(draft.skill_ids).ids.filter((value) => skillIds.has(value));
        await tx.$executeRawUnsafe(
          `INSERT INTO tasks (id, group_id, parent_task_id, sort_order, type, title, description, status, priority, skills, breakdown_session_id, review_mode)
           VALUES (?, ?, ?, ?, '子任务', ?, ?, 'BACKLOG', ?, ?, ?, ?)`,
          taskId,
          session.group_id ?? DEFAULT_GROUP_ID,
          parentTaskId,
          draft.sort_order ?? 0,
          draft.title,
          draft.description,
          draft.priority ?? 3,
          JSON.stringify(skills),
          sessionId,
          reviewMode,
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
        `UPDATE breakdown_sessions
            SET status = 'completed', confirmed_at = datetime('now'), parent_task_id = ?, revision = revision + 1
          WHERE id = ?`,
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
   * 差别只在守卫状态——reportDraft 要 receiving（#34 后仅再放行「重新生成」待重报草案的
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

    // depends_on 未显式改动时原样保留待重报态：显式列行不动；旧库行若仍是 JSON 哨兵
    // （parseArray 会误吞成 []）也原样保留——改标题/描述不该悄悄清除待重报。
    // 显式传 depends_on 视为用户接管依赖边：写入规范化数组，并清空 regeneration 三列。
    const nextDependsOn =
      patch.depends_on === undefined
        ? hasRegenerationFlag(row.depends_on)
          ? (row.depends_on as string)
          : JSON.stringify(parseArray<string>(row.depends_on))
        : JSON.stringify(normalizeRefs(patch.depends_on, 'depends_on'));
    // 裁定 3（2026-09-21「重选即消歧」）：本次 PATCH 携带 skill_ids 且全部是真实技能 id
    // （用户在候选列表上显式重选落定）→ 行上落 user_disambiguated 标记，读侧不再把这条
    // 标 ambiguous；含名字/查无值的列表不标记，走 §7.5 原口径。未传 skill_ids 时原样保留
    // 现列——落定值与既有标记都不丢也不误清。
    let nextSkillIds: string;
    if (patch.skill_ids === undefined) {
      nextSkillIds = row.skill_ids ?? '[]';
    } else {
      const ids = normalizeRefs(patch.skill_ids, 'skill_ids');
      const explicitIds =
        ids.length > 0 &&
        (
          await this.prisma.$queryRawUnsafe<{ id: string }[]>(
            `SELECT id FROM skills WHERE id IN (${placeholders(ids.length)})`,
            ...ids,
          )
        ).length === ids.length;
      nextSkillIds = explicitIds ? skillColumnJson(ids, true) : JSON.stringify(ids);
    }

    const next = {
      title: patch.title === undefined ? row.title : text(patch.title, 'title'),
      description: patch.description === undefined ? row.description : patch.description,
      priority: patch.priority ?? row.priority ?? 3,
      skill_ids: nextSkillIds,
      acceptance: JSON.stringify(
        patch.acceptance === undefined
          ? parseArray<string>(row.acceptance)
          : toStringArray(patch.acceptance, 'acceptance').map((v) => v.trim()).filter(Boolean),
      ),
      depends_on: nextDependsOn,
      sort_order: patch.sort_order ?? row.sort_order ?? 0,
    };
    // #4：只有显式改 depends_on 才清重生成三列（用户接管依赖边）；改标题/描述等局部编辑
    // 保持「待 Agent 重报」不动。guardReviewingUpdate 自带 revision+1。
    const regenerationReset =
      patch.depends_on === undefined
        ? ''
        : ', regeneration_pending = 0, regeneration_note = NULL, regeneration_requested_at = NULL';
    await this.prisma.$transaction(async (tx) => {
      this.assertReviewingGuard(await guardReviewingUpdate(tx, sessionId));
      await tx.$executeRawUnsafe(
        `UPDATE breakdown_drafts
            SET title = ?, description = ?, priority = ?, skill_ids = ?, acceptance = ?, depends_on = ?, sort_order = ?${regenerationReset}
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
   * §7.4「重新生成」（条款 81 补齐 + #4）：重置该草案待 Agent 重报——title 置占位、
   * description/skill_ids/acceptance/depends_on 清空，显式列 regeneration_pending=1，
   * 并记录用户的改写说明与请求时刻。priority/sort_order 属用户在确认页可调的排布
   * 字段，原样保留。仅 reviewing 可写，并发守卫与其余写端点同款（revision+1）。
   * 广播既有 `breakdown.task_draft`（确认页刷新）与 `breakdown.revision_requested`
   * （scope=draft，携带 note）。#34 配对：Agent 用 `board.report_task_draft` 重报
   * 该 ref 即整行覆盖并清空重生成三列；用户在确认页上的其余编辑不受影响。
   */
  async userRegenerateDraft(sessionId: string, ref: string, note?: string): Promise<DraftDtoShape[]> {
    const session = await this.requireSession(sessionId);
    this.assertStatus(session, 'reviewing', ['reviewing']);
    const existing = await this.drafts(sessionId);
    const row = existing.find((draft) => draft.ref === ref);
    if (!row) throw draftNotFound(sessionId, ref);
    const regenerationNote = normalizeNote(note);

    await this.prisma.$transaction(async (tx) => {
      this.assertReviewingGuard(await guardReviewingUpdate(tx, sessionId));
      await tx.$executeRawUnsafe(
        `UPDATE breakdown_drafts
            SET title = ?, description = NULL, skill_ids = '[]', acceptance = '[]', depends_on = '[]',
                regeneration_pending = 1, regeneration_note = ?, regeneration_requested_at = datetime('now')
          WHERE id = ?`,
        REGENERATION_PLACEHOLDER_TITLE,
        regenerationNote,
        row.id,
      );
    });
    this.events.emit('breakdown.task_draft', { session_id: sessionId, ref });
    this.events.emit('breakdown.revision_requested', {
      session_id: sessionId,
      scope: 'draft',
      refs: [ref],
      note: regenerationNote,
    });
    return (await this.drafts(sessionId)).map(toDraftDto);
  }

  /**
   * #4 整份重生成：reviewing 会话交给 Agent 按用户的 note 重新拆一遍。所有草案重置为
   * 「待重报空壳」而不是删除——确认页在等待期间仍能看到旧计划与待重生成标记；Agent
   * 重报同 ref 即清 pending；会话级重生成后未重报的 ref 会阻塞 finish（409），
   * 调用方须逐条重报销账（见 finish / assertNoPendingRegeneration）。
   * 会话回 receiving，revision 由 guardReviewingUpdate 递增（会话级只跳一格），并记录
   * revision_note/requested_at。审计 breakdown_regenerate（user）。
   */
  async regenerateSession(sessionId: string, note?: string): Promise<BreakdownSessionDetail> {
    const session = await this.requireSession(sessionId);
    this.assertStatus(session, 'reviewing', ['reviewing']);
    const regenerationNote = normalizeNote(note);
    const refs = (await this.drafts(sessionId)).map((draft) => draft.ref);

    await this.prisma.$transaction(async (tx) => {
      this.assertReviewingGuard(await guardReviewingUpdate(tx, sessionId));
      await tx.$executeRawUnsafe(
        `UPDATE breakdown_drafts
            SET title = ?, description = NULL, skill_ids = '[]', acceptance = '[]', depends_on = '[]',
                regeneration_pending = 1, regeneration_note = ?, regeneration_requested_at = datetime('now')
          WHERE session_id = ?`,
        REGENERATION_PLACEHOLDER_TITLE,
        regenerationNote,
        sessionId,
      );
      await tx.$executeRawUnsafe(
        `UPDATE breakdown_sessions
            SET status = 'receiving', finished_at = NULL, revision_note = ?, revision_requested_at = datetime('now')
          WHERE id = ?`,
        regenerationNote,
        sessionId,
      );
    });
    await this.audit.record({
      actorType: 'user',
      action: 'breakdown_regenerate',
      targetType: 'breakdown_session',
      targetId: sessionId,
      before: { status: 'reviewing' },
      after: { status: 'receiving', note: regenerationNote },
    });
    this.events.emit('breakdown.revision_requested', {
      session_id: sessionId,
      scope: 'session',
      refs,
      note: regenerationNote,
    });
    return this.get(sessionId);
  }

  // ---------------------------------------------------------- 阶段 6：finish 后的长轮询

  /**
   * #4：`board.wait_for_breakdown`——finish 之后 Agent 不退出，挂在这里等用户动作。
   * 每 1000ms 只读一次 sessions + drafts（不跑 skill 注解等读侧重活），直到：
   *  - 终态：completed→confirmed、cancelled→cancelled、interrupted→interrupted（不看 revision）；
   *  - reviewing 出现待重报草案（draft_regenerate）或 revision 越过基线（user_edited）；
   *  - receiving：有 revision_requested_at → session_regenerate，否则 → receiving（继续上报）；
   *  - 超时：timeout，changed 仍按 revision 是否越过基线给出。
   * 基线：省略 afterRevision 时取本次调用开始时的 revision；显式传入时以调用方最后看到的为准。
   * 并发安全：每轮都重新查库，不缓存快照；sleep 不占事件循环。
   */
  async waitForBreakdown(
    sessionId: string,
    afterRevision?: number,
    timeoutSeconds = 25,
  ): Promise<BreakdownWaitResult> {
    let session = await this.requireSession(sessionId);
    const baseline =
      typeof afterRevision === 'number' && Number.isFinite(afterRevision)
        ? afterRevision
        : session.revision;
    const timeout = clampWaitSeconds(timeoutSeconds);
    const deadline = Date.now() + timeout * 1000;
    let drafts = await this.drafts(sessionId);

    for (;;) {
      const action = waitActionOf(session, drafts, baseline);
      if (action) return toWaitResult(session, drafts, baseline, action);
      const remaining = deadline - Date.now();
      if (remaining <= 0) {
        // 超时前最后读一次：返回最新 revision/status，Agent 用 after_revision 续等不会漏拍。
        [session, drafts] = await Promise.all([
          this.requireSession(sessionId),
          this.drafts(sessionId),
        ]);
        return toWaitResult(session, drafts, baseline, 'timeout');
      }
      await sleep(Math.min(WAIT_POLL_INTERVAL_MS, remaining));
      [session, drafts] = await Promise.all([
        this.requireSession(sessionId),
        this.drafts(sessionId),
      ]);
    }
  }

  // ---------------------------------------------------------------- 取消与读侧

  async cancel(sessionId: string): Promise<SessionDtoShape> {
    const session = await this.requireSession(sessionId);
    this.assertStatus(session, 'receiving 或 reviewing', ['receiving', 'reviewing']);
    await this.prisma.$executeRawUnsafe(
      `UPDATE breakdown_sessions
          SET status = 'cancelled', cancelled_at = datetime('now'), revision = revision + 1
        WHERE id = ?`,
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

  /**
   * #4 列表：scope（active/history/all）+ 归档父需求过滤 + 需求过滤 + keyset 分页。
   * 返回仍是数组（不改响应外形）；默认 limit=100（clamp 1..500）。cursor 指向
   * (created_at, id) 的 keyset 条件，created_at 秒级并列时用 id（UUIDv7）稳定排序。
   */
  async list(query: BreakdownListQuery = {}): Promise<SessionDtoShape[]> {
    const conditions: string[] = [];
    const params: unknown[] = [];

    const scope = query.scope ?? 'all';
    if (scope === 'active') {
      conditions.push(`status IN ('receiving', 'reviewing', 'creating')`);
    } else if (scope === 'history') {
      conditions.push(`status IN ('completed', 'cancelled', 'interrupted')`);
    }

    // include_archived=false（默认）时排除父需求已归档的会话。表不设别名：派生列表达式
    // 直接引用 breakdown_sessions.parent_task_id，list 与 requireSession 共用同一列拼装。
    if (query.include_archived !== true) {
      conditions.push(
        `(parent_task_id IS NULL OR (SELECT archived_at FROM tasks WHERE tasks.id = breakdown_sessions.parent_task_id) IS NULL)`,
      );
    }

    const requirementId = query.requirement_id?.trim();
    if (requirementId) {
      conditions.push(`parent_task_id = ?`);
      params.push(requirementId);
    }

    if (query.cursor) {
      const cursorRows = await this.prisma.$queryRawUnsafe<{ created_at: string }[]>(
        `SELECT created_at FROM breakdown_sessions WHERE id = ?`,
        query.cursor,
      );
      const cursorRow = cursorRows[0];
      if (!cursorRow) {
        throw new ApiException('INVALID_PARAM', 'cursor 指向的拆解会话不存在', undefined, {
          cursor: query.cursor,
        });
      }
      conditions.push(`(created_at < ? OR (created_at = ? AND id < ?))`);
      params.push(cursorRow.created_at, cursorRow.created_at, query.cursor);
    }

    const rawLimit = query.limit ?? 100;
    const limit = Math.min(500, Math.max(1, Number.isFinite(rawLimit) ? Math.trunc(rawLimit) : 100));
    const where = conditions.length > 0 ? ` WHERE ${conditions.join(' AND ')}` : '';
    const rows = await this.prisma.$queryRawUnsafe<SessionRow[]>(
      `SELECT ${SESSION_COLUMNS} FROM breakdown_sessions${where} ORDER BY created_at DESC, id DESC LIMIT ?`,
      ...params,
      limit,
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

  /**
   * #4：finish / confirm 共用的硬性守卫——存在待重生成草案（显式列或旧哨兵）即 409，
   * 既不让占位空壳建成任务，也不让会话级重生成被「不重报直接收尾」静默吞掉。
   * 旧哨兵只会出现在 reviewing（confirm 侧）；receiving 的 finish 只认显式列。
   */
  private assertNoPendingRegeneration(drafts: DraftRow[], sessionId: string): void {
    const refs = drafts.filter(isRegenerationPending).map((draft) => draft.ref);
    if (refs.length === 0) return;
    throw new ApiException(
      'BREAKDOWN_REGENERATION_PENDING',
      `存在待重新生成的草案（refs: ${refs.join(', ')}），请等待 Agent 重报或先取消`,
      undefined,
      { session_id: sessionId, refs },
    );
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
    const columns = drafts.map((draft) => parseSkillIdsColumn(draft.skill_ids));
    const values = [...new Set(columns.flatMap((column) => column.ids))];
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
    const perDraft = drafts.map((draft, index) => {
      const statuses = columns[index]!.ids.flatMap((value) => {
        const entry = info.get(value);
        if (!entry) return [];
        if (entry.state === 'ambiguous') {
          // 裁定 3：用户重选即消歧——带标记的行是用户显式落定的 id，同名碰撞不再标
          // ambiguous、不进 skill_resolution；未标记的行维持条款 81 原标注口径。
          if (columns[index]!.userDisambiguated) {
            return [{ ...entry, state: 'resolved' as const, skill_id: value, candidates: [value] }];
          }
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

  /**
   * §7.7：status 条件 UPDATE 命中 0 行＝写事务开始时会话已不在 reviewing（confirm/超时收敛
   * 抢先），统一 409。#4：命中时同一语句顺带 revision+1——所有用户侧写端点（含 Agent 对
   * 重生成草案的重报）共用这一处递增，调用处不要二次递增。
   */
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
        regeneration_pending: 0,
        regeneration_note: null,
        regeneration_requested_at: null,
        sort_order: null,
      });
    }
    this.assertDraftGraph(prospective, sessionId);
  }

  private async drafts(sessionId: string): Promise<DraftRow[]> {
    return this.prisma.$queryRawUnsafe<DraftRow[]>(
      `SELECT id, session_id, ref, title, description, priority, skill_ids, acceptance, depends_on,
              regeneration_pending, regeneration_note, regeneration_requested_at, sort_order
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
  /** #4：用户本次重生成想改什么（未填为 null）；仅 pending 时与 requested_at 一起透出。 */
  regeneration_note?: string | null;
  /** #4：重生成请求时刻；旧哨兵行无历史时刻，为 null。 */
  regeneration_requested_at?: string | null;
  /** 裁定 3「重选即消歧」：技能列表由用户显式重选落定。仅置真时出现（旧消费者零扰动）。 */
  user_disambiguated?: boolean;
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
  const skills = parseSkillIdsColumn(row.skill_ids);
  const dto: DraftDtoShape = {
    id: row.id,
    ref: row.ref,
    title: row.title,
    description: row.description,
    priority: row.priority ?? 3,
    skill_ids: skills.ids,
    acceptance: parseArray<string>(row.acceptance),
    depends_on: parseArray<string>(row.depends_on),
    sort_order: row.sort_order ?? 0,
  };
  // #4：显式列或旧哨兵任一为真即 pending；pending 时同时透出 note/requested_at
  //（旧哨兵行二者为 null）。非 pending 不出现三字段，旧消费者零扰动。
  if (isRegenerationPending(row)) {
    dto.regeneration_pending = true;
    dto.regeneration_note = row.regeneration_note ?? null;
    dto.regeneration_requested_at = row.regeneration_requested_at ?? null;
  }
  if (skills.userDisambiguated) dto.user_disambiguated = true;
  return dto;
}

// ------------------------------------------- #4 wait_for_breakdown 的轮询与动作判定

const WAIT_POLL_INTERVAL_MS = 1000;
const WAIT_TIMEOUT_DEFAULT_SECONDS = 25;
const WAIT_TIMEOUT_MAX_SECONDS = 55;

type BreakdownWaitAction = BreakdownWaitResult['action'];

/** 服务层兜底 1..55 秒；zod 层已限制 5..55（测试与内部调用可传更短）。 */
function clampWaitSeconds(seconds: number | undefined): number {
  const value =
    typeof seconds === 'number' && Number.isFinite(seconds)
      ? Math.trunc(seconds)
      : WAIT_TIMEOUT_DEFAULT_SECONDS;
  return Math.min(WAIT_TIMEOUT_MAX_SECONDS, Math.max(1, value));
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * 一次快照上的动作判定；null = 还没有用户动作，继续轮询。
 * 优先级：终态 → reviewing（待重报 > 用户编辑）→ receiving（会话级重生成 > 继续上报）。
 */
function waitActionOf(
  session: SessionDtoShape,
  drafts: DraftRow[],
  baseline: number,
): Exclude<BreakdownWaitAction, 'timeout'> | null {
  if (session.status === 'completed') return 'confirmed';
  if (session.status === 'cancelled') return 'cancelled';
  if (session.status === 'interrupted') return 'interrupted';
  if (session.status === 'reviewing') {
    if (drafts.some(isRegenerationPending)) return 'draft_regenerate';
    if (session.revision > baseline) return 'user_edited';
    // 用户还没动：继续等，until 超时。
    return null;
  }
  if (session.status === 'receiving') {
    // 会话级重生成会写 revision_requested_at；Agent 自己的上报只递增 revision、不写该列。
    if (session.revision_requested_at) return 'session_regenerate';
    return 'receiving';
  }
  // creating 是 confirm 事务内的瞬时中间态：没有可执行动作，继续等到终态或超时。
  return null;
}

function toWaitResult(
  session: SessionDtoShape,
  drafts: DraftRow[],
  baseline: number,
  action: BreakdownWaitAction,
): BreakdownWaitResult {
  const pending = drafts.filter(isRegenerationPending);
  const notes = pending.map((draft) => ({
    ref: draft.ref,
    note: draft.regeneration_note ?? null,
    requested_at: draft.regeneration_requested_at ?? null,
  }));
  const refs =
    action === 'draft_regenerate' || action === 'session_regenerate'
      ? pending.map((draft) => draft.ref)
      : [];
  // 单草案重生成可能带不同说明：note 汇总为全部非空说明（多条用「；」连接）；
  // 会话级重生成以会话上的 revision_note 为准。
  const note =
    action === 'draft_regenerate'
      ? uniqueNotes(notes).join('；') || null
      : action === 'session_regenerate'
        ? session.revision_note ?? null
        : null;
  return {
    session_id: session.id,
    status: session.status,
    revision: session.revision,
    changed: session.revision > baseline,
    action,
    refs,
    note,
    notes,
    message: waitMessage(action, refs, note),
  };
}

function uniqueNotes(notes: { note: string | null }[]): string[] {
  return [...new Set(notes.map((entry) => entry.note).filter((note): note is string => Boolean(note)))];
}

/** 按 action 给出可执行的中文下一步；Agent 只读 MCP 描述与 instructions，文案必须点名工具。 */
function waitMessage(action: BreakdownWaitAction, refs: string[], note: string | null): string {
  switch (action) {
    case 'draft_regenerate':
      return `用户要求重新生成草案 ${refs.join('、')}${note ? `（说明：${note}）` : ''}：请用 board.report_task_draft 逐条重报这些 ref，落实说明中的修改；重报后会话仍在待确认（无需 finish），继续等待时先调 board.get_breakdown 取最新 revision 作为 after_revision，或省略 after_revision 从现在开始等。`;
    case 'session_regenerate':
      return `用户要求整份重新拆解${note ? `（说明：${note}）` : ''}：先调 board.get_breakdown 查看全量草案与会话说明，按说明重报（receiving 期可新增/覆盖 ref），完成后调 board.finish_breakdown。`;
    case 'user_edited':
      return '用户编辑了草案但未要求重生成：请调 board.get_breakdown 读取最新内容，不要覆盖用户的编辑；随后用返回的 session.revision 作为 after_revision 再调 board.wait_for_breakdown。';
    case 'confirmed':
      return '会话已确认并创建任务，结束。';
    case 'cancelled':
      return '会话已被用户取消，结束。';
    case 'interrupted':
      return '会话已中断（超过保留期或异常），结束；草案可查不可确认。';
    case 'receiving':
      return '会话正在接收拆解结果：继续用 board.report_task_draft 上报草案（同 ref 会覆盖），完成后调 board.finish_breakdown。';
    case 'reviewing':
      return '用户尚未操作，继续调用 board.wait_for_breakdown 等待。';
    case 'timeout':
      return '本次等待超时、用户还没有动作：请带上当前 revision（after_revision）再次调用 board.wait_for_breakdown 继续等待。';
  }
}

/**
 * §7.4「重新生成」占位标题。纯本地架构服务端回调不了 Agent，「重新生成」= 把草案
 * 重置为**待 Agent 重报**。新写入把标记落在 0024 的显式列（regeneration_pending/
 * note/requested_at）；depends_on 恢复纯数组。历史库行可能仍把标记存成 depends_on
 * 的 JSON 对象 `{"regeneration_pending":true}`——读路径继续兼容（isRegenerationPending），
 * 但新写入一律走显式列。
 */
const REGENERATION_PLACEHOLDER_TITLE = '（待重新生成）';

/** #4：待重报判定——显式列优先，旧哨兵只读兼容（迁移 0024 已把存量行转成显式列）。 */
function isRegenerationPending(row: Pick<DraftRow, 'regeneration_pending' | 'depends_on'>): boolean {
  return (
    (typeof row.regeneration_pending === 'number' ? row.regeneration_pending : Number(row.regeneration_pending)) === 1 ||
    hasRegenerationFlag(row.depends_on)
  );
}

/** 历史哨兵只读兼容：旧库行 depends_on 里的 JSON 对象 `{"regeneration_pending":true}`。 */
function hasRegenerationFlag(json: string | null): boolean {
  if (!json) return false;
  try {
    const value: unknown = JSON.parse(json);
    return typeof value === 'object' && value !== null && (value as { regeneration_pending?: unknown }).regeneration_pending === true;
  } catch {
    return false;
  }
}

/** #4：重生成说明规整——trim；空串/undefined → null；>2000 字服务层兜底 422。 */
function normalizeNote(note: string | undefined | null): string | null {
  if (note === undefined || note === null) return null;
  const trimmed = note.trim();
  if (!trimmed) return null;
  if (trimmed.length > 2000) {
    throw new ApiException('VALIDATION_FAILED', '重生成说明不能超过 2000 字', [
      { path: 'note', code: 'too_big', message: '≤ 2000' },
    ]);
  }
  return trimmed;
}

/**
 * 裁定 3（2026-09-21）「重选即消歧」的标记载体：skill_ids 列除既有的 JSON 数组外，
 * 新增对象形 `{"skill_ids":[...], "user_disambiguated":true}`——只在用户 PATCH 显式
 * id 列表时落标记，未标记行仍存纯数组（旧消费者零扰动）。选它而不是「另起一列 JSON
 * 对象顶掉数组」：技能列表不能被标记顶掉（confirm/toDraftDto 都要读 id），
 * 数组旁挂标记又会污染逐值消费者；对象包数组让 parseArray 对未升级读者自然降级
 * ——本仓库内 skill_ids 的读方只有本文件，已全部走 parseSkillIdsColumn。
 * reportDraft（含 #34 待重报 B 通道重报）整行覆盖必写回纯数组，标记随覆盖消失，
 * 回到名字碰撞解析原语义（条款 81 口径一字不动）。
 */
interface SkillIdsColumn {
  ids: string[];
  userDisambiguated: boolean;
}

function parseSkillIdsColumn(json: string | null): SkillIdsColumn {
  if (!json) return { ids: [], userDisambiguated: false };
  try {
    const value: unknown = JSON.parse(json);
    if (Array.isArray(value)) return { ids: value as string[], userDisambiguated: false };
    if (
      typeof value === 'object' &&
      value !== null &&
      Array.isArray((value as { skill_ids?: unknown }).skill_ids)
    ) {
      const column = value as { skill_ids: string[]; user_disambiguated?: unknown };
      return { ids: column.skill_ids, userDisambiguated: column.user_disambiguated === true };
    }
    return { ids: [], userDisambiguated: false };
  } catch {
    return { ids: [], userDisambiguated: false };
  }
}

function skillColumnJson(ids: string[], userDisambiguated: boolean): string {
  return userDisambiguated ? JSON.stringify({ skill_ids: ids, user_disambiguated: true }) : JSON.stringify(ids);
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
  return [...new Set(drafts.flatMap((d) => parseSkillIdsColumn(d.skill_ids).ids))];
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
 * #4：命中时顺带 revision+1——会话内容将被本次写端点改变，调用处不再二次递增。
 */
async function guardReviewingUpdate(tx: Prisma.TransactionClient, sessionId: string): Promise<number> {
  return tx.$executeRawUnsafe(
    `UPDATE breakdown_sessions SET status = 'reviewing', revision = revision + 1 WHERE id = ? AND status = 'reviewing'`,
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
