import { Injectable } from '@nestjs/common';
import { ApiException } from '../contract/errors';
import { DEFAULT_GROUP_ID } from '../contract/enums';
import { newId, nextTaskId } from '../contract/ids';
import type { CreateTaskToolInput } from '../contract/agent-schemas';
import { AuditService } from '../infra/audit.service';
import { EventsService } from '../infra/events.service';
import { PrismaService } from '../infra/prisma.service';
import { SettingsService } from '../infra/settings.service';
import type { SkillsService } from '../skills/skills.service';

/**
 * v0.0.4 W8 §8.7 会话创建闭环的服务层——本片只做「直接创建 / 静默创建」两种模式的
 * 核心落库：任务 + agent_sessions（按 session_id upsert，刷新 last_active_at/task_count）
 * + task_creation_logs（每次创建一条）在同一事务内完成，全成或全滚。
 *
 * 轻确认（light）的决策闭环——creation-requests、WS `agent.task_requested` 卡片、
 * `POST /creation-requests/{id}/decision`、超时降级——归下一切片，这里以
 * NOT_IMPLEMENTED(501) 占位（§8.2 三模式语义不吞声）。
 * 模式优先级（§8.2：参数 > 设置「创建模式」> 默认轻确认）中设置键随设置页重组落地，
 * 本切片缺省即默认轻确认 → 未显式传 direct/silent 的调用会拿到 NOT_IMPLEMENTED。
 */

/** §8.2 三模式的对外词表（confirmation_mode 参数 / tasks.confirmation_mode 列同词表）。 */
export type CreationMode = 'direct' | 'light' | 'silent';

export interface CreateTaskResult {
  created: true;
  task_id: string;
  session_id: string;
  agent_name: string;
  confirmation_mode: CreationMode;
  /** §7.5 同口径：填了名字但库里无此技能 → 丢弃不阻断，原值进告警回显。 */
  skill_resolution: { unresolved: string[] };
}

@Injectable()
export class CreationService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly settings: SettingsService,
    private readonly audit: AuditService,
    private readonly events: EventsService,
    /** 技能名→ID 解析后的绑定归一（{skill_id, version} JSON，与 REST 建任务同一存储形状）。 */
    private readonly skills: SkillsService,
  ) {}

  // ---------------------------------------------------------------- board.create_task

  async createFromAgent(input: CreateTaskToolInput, credentialName: string): Promise<CreateTaskResult> {
    const mode: CreationMode = input.confirmation_mode ?? 'light';
    if (mode === 'light') {
      throw new ApiException(
        'NOT_IMPLEMENTED',
        '轻确认模式（创建请求 + 决策回传闭环）尚未实现：请显式使用 direct 或 silent，或等待 W8 决策闭环切片',
        undefined,
        { confirmation_mode: mode, supported: ['direct', 'silent'] },
      );
    }

    const agentName = input.agent_name?.trim() || credentialName;
    const title = input.title.trim();
    if (!title) {
      throw new ApiException('VALIDATION_FAILED', 'title 不能为空', [
        { path: 'title', code: 'too_small', message: '必填' },
      ]);
    }
    // 类型词表与 REST 同源（settings.task_types）；§8.8：需求不在此创建，走拆解流程。
    const types = await this.settings.get('task_types');
    if (!types.includes(input.type)) {
      throw new ApiException('VALIDATION_FAILED', `任务类型「${input.type}」不在词表内`, [
        { path: 'type', code: 'unknown_type', message: `可选：${types.join(' / ')}` },
      ]);
    }
    if (input.type === '需求') {
      throw new ApiException('VALIDATION_FAILED', '需求类型请走拆解流程（board.begin_breakdown），不经 create_task 直建', [
        { path: 'type', code: 'use_breakdown', message: '需求' },
      ]);
    }
    if (input.group_id) await this.assertActiveGroup(input.group_id);

    // 技能解析（§7.5 r3 口径）：值已是 id 直通；否则按 name 精确匹配取最近更新者；
    // 无命中的丢弃并进 skill_resolution——与拆解确认页一样，不因坏引用阻断创建。
    const { skillIds, unresolved } = await this.resolveSkills(input.skills);
    const skillsJson =
      skillIds.length === 0
        ? '[]'
        : await this.skills.normalizeTaskBindings(skillIds.map((id) => ({ skill_id: id })));

    const taskId = await this.prisma.$transaction(async (tx) => {
      const id = await nextTaskId(tx);
      await tx.$executeRawUnsafe(
        `INSERT INTO tasks (id, group_id, type, title, description, status, priority, tags, skills,
                            origin_type, origin_agent, origin_session_id, confirmation_mode)
         VALUES (?, ?, ?, ?, ?, 'BACKLOG', ?, ?, ?, 'agent', ?, ?, ?)`,
        id,
        input.group_id ?? DEFAULT_GROUP_ID,
        input.type,
        title,
        input.description ?? null,
        input.priority,
        JSON.stringify(input.tags),
        skillsJson,
        agentName,
        input.session_id,
        mode,
      );
      // §8.7：按 session_id upsert——首见建会话（started_at/last_active_at 吃列默认值，
      // 首条创建即计 1），再见刷新活跃时刻并计数；task_count 只在真正建成任务时 +1（本事务内）。
      await tx.$executeRawUnsafe(
        `INSERT INTO agent_sessions (id, session_id, agent_name, task_count) VALUES (?, ?, ?, 1)
         ON CONFLICT(session_id) DO UPDATE SET
           last_active_at = datetime('now'),
           task_count = agent_sessions.task_count + 1`,
        newId(),
        input.session_id,
        agentName,
      );
      // §8.7：每次创建一条流水（取消/超时两条路径随轻确认闭环补上）。
      await tx.$executeRawUnsafe(
        `INSERT INTO task_creation_logs (task_id, session_id, agent_name, source, confirmation, user_action)
         VALUES (?, ?, ?, 'mcp', ?, 'created')`,
        id,
        input.session_id,
        agentName,
        mode,
      );
      await this.audit.record(
        {
          actorType: 'agent',
          actorName: agentName,
          action: 'task_create',
          targetType: 'task',
          targetId: id,
          after: { id, type: input.type, title, origin: 'agent', confirmation_mode: mode },
        },
        tx,
      );
      return id;
    });

    this.events.emit('task.created', { id: taskId });
    return {
      created: true,
      task_id: taskId,
      session_id: input.session_id,
      agent_name: agentName,
      confirmation_mode: mode,
      skill_resolution: { unresolved },
    };
  }

  // ---------------------------------------------------------------- 内部件

  /** 与 BreakdownService.resolveSkills 同政策的单任务版：id 直通、name 取最近更新、无命中报 unresolved。 */
  private async resolveSkills(values: string[]): Promise<{ skillIds: string[]; unresolved: string[] }> {
    const unique = [...new Set(values)];
    if (unique.length === 0) return { skillIds: [], unresolved: [] };

    const idRows = await this.prisma.$queryRawUnsafe<{ id: string }[]>(
      `SELECT id FROM skills WHERE id IN (${placeholders(unique.length)})`,
      ...unique,
    );
    const known = new Set(idRows.map((row) => row.id));
    const names = unique.filter((value) => !known.has(value));
    const skillIds = unique.filter((value) => known.has(value));
    const unresolved: string[] = [];
    if (names.length > 0) {
      const hits = await this.prisma.$queryRawUnsafe<{ id: string; name: string }[]>(
        `SELECT id, name FROM skills WHERE name IN (${placeholders(names.length)}) ORDER BY updated_at DESC, id DESC`,
        ...names,
      );
      const picked = new Map<string, string>();
      for (const hit of hits) if (!picked.has(hit.name)) picked.set(hit.name, hit.id);
      for (const name of names) {
        const id = picked.get(name);
        if (id) skillIds.push(id);
        else unresolved.push(name);
      }
    }
    // id 直通与 name 解析可能撞同一技能（["skl_x", "单元测试"] 且名字就是那条）——绑定去重。
    return { skillIds: [...new Set(skillIds)], unresolved };
  }

  /** 与 TasksService/BreakdownService.assertGroup 同口径：不存在 404、归档组只读 409。 */
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

function placeholders(count: number): string {
  return Array.from({ length: count }, () => '?').join(',');
}
