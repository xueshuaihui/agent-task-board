import { Injectable } from '@nestjs/common';
import { ApiException } from '../contract/errors';
import {
  DEFAULT_GROUP_ID,
  type BreakdownSessionStatus,
} from '../contract/enums';
import { newId, nextTaskId } from '../contract/ids';
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

  /** 同 (session_id, ref) 再上报即整体覆盖（§7.6 UNIQUE；阶段 4 允许 Agent 修订草案）。 */
  async reportDraft(sessionId: string, input: BreakdownDraftInput): Promise<DraftDtoShape> {
    const session = await this.requireSession(sessionId);
    this.assertStatus(session, 'receiving', ['receiving']);
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

    const id = newId();
    await this.prisma.$executeRawUnsafe(
      `INSERT INTO breakdown_drafts (id, session_id, ref, title, description, priority, skill_ids, acceptance, depends_on, sort_order)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(session_id, ref) DO UPDATE SET
         title = excluded.title, description = excluded.description, priority = excluded.priority,
         skill_ids = excluded.skill_ids, acceptance = excluded.acceptance,
         depends_on = excluded.depends_on, sort_order = excluded.sort_order`,
      id,
      sessionId,
      ref,
      title,
      input.description ?? null,
      priority,
      JSON.stringify(input.skill_ids ?? []),
      JSON.stringify(input.acceptance ?? []),
      JSON.stringify(dependsOn),
      input.sort_order ?? 0,
    );
    const row = await this.drafts(sessionId);
    const dto = toDraftDto(row.find((d) => d.ref === ref)!);
    this.events.emit('breakdown.task_draft', { session_id: sessionId, ref });
    return dto;
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

    this.events.emit('task.created', { id: created.parentTaskId });
    for (const taskId of created.taskIds) this.events.emit('task.created', { id: taskId });
    return {
      session: await this.requireSession(sessionId),
      parent_task_id: created.parentTaskId,
      task_ids: created.taskIds,
    };
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
    return {
      session,
      drafts: drafts.map(toDraftDto),
      progress: progress.map((row) => ({
        id: row.id,
        step: row.step,
        total: row.total,
        message: row.message,
        created_at: row.created_at,
      })),
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
}

export interface BreakdownSessionDetail {
  session: SessionDtoShape;
  drafts: DraftDtoShape[];
  progress: { id: number; step: number; total: number; message: string | null; created_at: string }[];
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
  return {
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

function assertEstimated(value: number): void {
  if (!Number.isInteger(value) || value < 1) {
    throw new ApiException('VALIDATION_FAILED', 'estimated_tasks 须为正整数', [
      { path: 'estimated_tasks', code: 'too_small', message: '≥ 1' },
    ]);
  }
}
