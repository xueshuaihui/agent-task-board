import { Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import { ApiException } from '../contract/errors';
import { DEFAULT_GROUP_ID, type AgentConfirmationMode } from '../contract/enums';
import { newId, nextTaskId } from '../contract/ids';
import type { CreateTaskToolInput, CreateTasksBatchInput } from '../contract/agent-schemas';
import type { CreationDecisionInput, CreationRequestCreateInput } from './creation.dto';
import { AuditService } from '../infra/audit.service';
import { EventsService } from '../infra/events.service';
import { NotificationsService } from '../infra/notifications.service';
import { PrismaService } from '../infra/prisma.service';
import { SettingsService } from '../infra/settings.service';
import { SkillsService } from '../skills/skills.service';

/**
 * v0.0.4 W8 §8.7 会话创建闭环的服务层：
 *  · direct / silent：单事务落 task + agent_sessions upsert + task_creation_logs + 审计（第一片已就位）；
 *  · light（本切片）：待决请求（内存态）→ WS `agent.task_requested` 卡片 →
 *    REST `POST /creation-requests/{id}/decision`（create/edit/cancel）回传决策；
 *    `board.create_task` 缺省服务端阻塞等待，最长 = 轻确认超时（设置键，默认 30s）+ 5s 宽限，
 *    到期按「超时→不创建」返回（§8.7 r3）；`wait:false` 立即返回 request_id，
 *    用 `board.get_creation_status` 轮询 / `board.wait_for_confirmation` 阻塞等。
 *  · 模式优先级（§8.2）：请求参数 confirmation_mode > 设置 agent_creation_mode > 默认轻确认；
 *    direct 命中重复检测（§8.5）时升级为轻确认卡片。
 *
 * 待决请求刻意不落表：0013 只给了 task_creation_logs（task_id NOT NULL，待决期无任务可挂），
 * PRD §8.9 也未定义独立请求表——请求本体驻内存，创建/取消/超时各落一条流水（§8.7），
 * 服务重启即卡片消失，符合「30 秒浮层」的生命周期定位。
 */

/** §8.2 三模式的对外词表（confirmation_mode 参数 / tasks.confirmation_mode 列同词表）：以 contract/enums 常量为唯一来源。 */
export type CreationMode = AgentConfirmationMode;

/** task_creation_logs.user_action 开放词表（0013 注释：created/edit/cancel/timeout 系）。 */
export type CreationUserAction = 'created' | 'edited' | 'cancelled' | 'timeout';

/** 请求终结态：pending + 四种归宿（edited 也回 created 语义的 task_id，动作词表区分）。 */
export type CreationRequestStatus = 'pending' | CreationUserAction;

/** §8.5 重复检测命中：卡片顶部「疑似重复任务」链接的数据源。 */
export interface CreationDuplicateHit {
  task_id: string;
  title: string;
  similarity: number;
}

export interface CreationRequestView {
  request_id: string;
  status: CreationRequestStatus;
  task_id: string | null;
  agent_name: string;
  session_id: string | null;
  source: 'mcp' | 'rest';
  title: string;
  description: string | null;
  group_id: string;
  type: string;
  priority: number;
  tags: string[];
  skills: string[];
  duplicates: CreationDuplicateHit[];
  created_at: string;
  /** 卡片倒计时终点（超时→不创建的判定点）。 */
  expires_at: string;
  /** +5s 决策宽限终点：过此时刻请求强制转 timeout，decision 拒收。 */
  decision_deadline_at: string;
}

export interface CreateTaskResult {
  created: true;
  task_id: string;
  request_id?: string;
  session_id: string | null;
  agent_name: string;
  confirmation_mode: CreationMode;
  /** §7.5 同口径：填了名字但库里无此技能 → 丢弃不阻断，原值进告警回显。 */
  skill_resolution: { unresolved: string[] };
}

export interface CreateTaskNotCreatedResult {
  created: false;
  request_id: string;
  /** 同步等待到决策的两种否定归宿（§8.3：取消→不创建 / 超时→不创建）。 */
  status: 'cancelled' | 'timeout';
  session_id: string | null;
  agent_name: string;
  confirmation_mode: 'light';
}

export interface CreateTaskPendingResult {
  created: false;
  /** §8.7 r3 异步模式：调用立即返回 request_id，Agent 改用轮询/等待工具收口。 */
  pending: true;
  request_id: string;
  session_id: string | null;
  agent_name: string;
  confirmation_mode: 'light';
  expires_at: string;
}

export type CreateTaskToolResult = CreateTaskResult | CreateTaskNotCreatedResult | CreateTaskPendingResult;

/** §8.7 批量：单条载荷校验/落库失败不熔断整批，逐条归宿各回各的。 */
export interface CreateTaskBatchItemFailure {
  index: number;
  created: false;
  error: { code: string; message: string };
}

export type CreateTaskBatchItemResult = CreateTaskToolResult | CreateTaskBatchItemFailure;

export interface CreateTasksBatchResult {
  /** 与入参 tasks 一一对位的逐条结果（含 index 定位的失败条目）。 */
  results: CreateTaskBatchItemResult[];
  task_ids: string[];
  /** light 条目（含 direct 命中重复升级的）的待决请求 id 列表，get_creation_status 轮询用。 */
  request_ids: string[];
}

/** validate 的入参形状：REST/edit 载荷可能没有 session_id（或为 null），统一按可空收。 */
type ValidateInput = Partial<Omit<CreateTaskToolInput, 'session_id'>> & { session_id?: string | null };

/** create_task 入参与 REST 待决请求共用的内部任务草稿形状（session_id 允许为空）。 */
interface CreationDraft {
  title: string;
  description: string | null;
  group_id: string;
  type: string;
  priority: number;
  tags: string[];
  skills: string[];
  session_id: string | null;
}

interface PendingRequest {
  id: string;
  draft: CreationDraft;
  agentName: string;
  source: 'mcp' | 'rest';
  confirmationMode: CreationMode;
  status: CreationRequestStatus;
  taskId: string | null;
  unresolved: string[];
  duplicates: CreationDuplicateHit[];
  createdAt: number;
  expiresAt: number;
  deadlineAt: number;
  timer: NodeJS.Timeout;
  settled: () => void;
  /** 阻塞等待决策的挂点：decision/超时收口时 resolve。 */
  done: Promise<void>;
}

/** §8.7 r3：轻确认超时后的决策宽限期，固定 5s，不给设置项开口子。 */
const DECISION_GRACE_MS = 5_000;
/** §8.5 重复检测：5 分钟时间窗 + Jaccard 相似度阈值。 */
const DUP_WINDOW_SQL = '-5 minutes';
const DUP_SIMILARITY = 0.8;
/** 已终结请求的内存保留窗口（get_creation_status 轮询/审计回看用）与容量上限。 */
const SETTLED_TTL_MS = 30 * 60_000;
const SETTLED_MAX = 200;

@Injectable()
export class CreationService implements OnModuleDestroy {
  private readonly logger = new Logger('creation');
  private readonly requests = new Map<string, PendingRequest>();

  constructor(
    private readonly prisma: PrismaService,
    private readonly settings: SettingsService,
    private readonly audit: AuditService,
    private readonly events: EventsService,
    /** 技能名→ID 解析后的绑定归一（{skill_id, version} JSON，与 REST 建任务同一存储形状）。 */
    private readonly skills: SkillsService,
    /** §13.9（r3）：creation_request 规则键的站内通知落库处（复用存量 notifications 模块，不新增存储）。 */
    private readonly notifications: NotificationsService,
  ) {}

  onModuleDestroy(): void {
    for (const entry of this.requests.values()) clearTimeout(entry.timer);
  }

  // ---------------------------------------------------------------- board.create_task

  async createFromAgent(input: CreateTaskToolInput, credentialName: string): Promise<CreateTaskToolResult> {
    const agentName = input.agent_name?.trim() || credentialName;
    const draft = await this.validate(input);
    // §8.2 优先级：参数 > 设置「创建模式」> 默认轻确认（agent_creation_mode 缺省即 light）。
    const mode: CreationMode = input.confirmation_mode ?? (await this.settings.get('agent_creation_mode'));

    if (mode === 'light') {
      return this.requestConfirmation(draft, agentName, 'mcp', 'light', input.wait !== false);
    }
    if (mode === 'direct') {
      // §8.2：直接创建不弹卡片，但重复检测命中时升级为轻确认卡片。
      const duplicates = await this.findDuplicates(draft);
      if (duplicates.length > 0) {
        return this.requestConfirmation(draft, agentName, 'mcp', 'light', input.wait !== false, duplicates);
      }
    }
    const { taskId, unresolved } = await this.persistCreated(draft, agentName, mode);
    return {
      created: true,
      task_id: taskId,
      session_id: draft.session_id,
      agent_name: agentName,
      confirmation_mode: mode,
      skill_resolution: { unresolved },
    };
  }

  // ---------------------------------------------------------------- board.create_tasks_batch

  /**
   * §8.7 批量创建（轻量版）：串行逐条复用 createFromAgent——direct/silent 的落库仍是
   * 每条自己的单事务（任务+会话记账+流水+审计），轻量版不开跨条 all-or-nothing 大事务；
   * 重复检测（§8.5）逐条生效，批内先建/先待决的条目会进入后条目的检测视野。
   * 单条失败（校验/归档组等）记条目错误后继续，不熔断整批。
   */
  async createBatchFromAgent(input: CreateTasksBatchInput, credentialName: string): Promise<CreateTasksBatchResult> {
    const results: CreateTaskBatchItemResult[] = [];
    for (const [index, item] of input.tasks.entries()) {
      try {
        const outcome = await this.createFromAgent(
          {
            ...item,
            session_id: input.session_id,
            agent_name: input.agent_name,
            confirmation_mode: input.confirmation_mode,
            wait: input.wait ?? false,
          },
          credentialName,
        );
        results.push(outcome);
      } catch (error) {
        if (!(error instanceof ApiException)) throw error;
        results.push({ index, created: false, error: { code: error.code, message: error.message } });
      }
    }
    return {
      results,
      task_ids: results.flatMap((r) => ('created' in r && r.created === true ? [r.task_id] : [])),
      request_ids: results.flatMap((r) => ('request_id' in r && r.request_id ? [r.request_id] : [])),
    };
  }

  // ---------------------------------------------------------------- 轻确认决策闭环（REST /creation-requests）

  /** 待决创建请求列表（§16.2：轻确认卡片数据源；含近期已终结项供 UI 收敛卡片状态）。 */
  async listRequests(): Promise<CreationRequestView[]> {
    this.pruneSettled();
    return [...this.requests.values()]
      .sort((a, b) => b.createdAt - a.createdAt)
      .map((entry) => this.view(entry));
  }

  /** POST /creation-requests：REST 侧生成待决请求（等同 light + wait:false 的 MCP 入口）。 */
  async createLightRequest(input: CreationRequestCreateInput): Promise<CreationRequestView> {
    const agentName = input.agent_name?.trim() || 'board';
    const draft = await this.validate({ ...input, session_id: input.session_id ?? null });
    const result = (await this.requestConfirmation(draft, agentName, 'rest', 'light', false)) as CreateTaskPendingResult;
    // requestConfirmation 的异步返回里必有 request_id，直接取回视图（含倒计时锚点）。
    return this.status(result.request_id);
  }

  /** board.get_creation_status / GET 语义：按请求 id 查当前归宿。 */
  status(requestId: string): CreationRequestView {
    const entry = this.requests.get(requestId);
    if (!entry) throw new ApiException('NOT_FOUND', `创建请求 ${requestId} 不存在（服务重启后待决请求即失效）`);
    return this.view(entry);
  }

  /** board.wait_for_confirmation：阻塞等到决策/超时收口（超时锚点由请求自身的定时器保证到达）。 */
  async waitFor(requestId: string): Promise<CreationRequestView> {
    const entry = this.requests.get(requestId);
    if (!entry) throw new ApiException('NOT_FOUND', `创建请求 ${requestId} 不存在（服务重启后待决请求即失效）`);
    if (entry.status === 'pending') await entry.done;
    return this.view(entry);
  }

  /** POST /creation-requests/{id}/decision：create / edit（带修改后载荷）/ cancel（§8.7 r3）。 */
  async decide(requestId: string, decision: CreationDecisionInput): Promise<CreationRequestView> {
    const entry = this.requests.get(requestId);
    if (!entry) throw new ApiException('NOT_FOUND', `创建请求 ${requestId} 不存在（服务重启后待决请求即失效）`);
    if (entry.status !== 'pending') {
      throw new ApiException('CREATION_REQUEST_RESOLVED', `创建请求已是终结态 ${entry.status}，决策拒收`, undefined, {
        request_id: requestId,
        status: entry.status,
      });
    }
    // 定时器滞后兜底：过了宽限终点按「超时→不创建」就地收口，再拒收本次决策。
    if (Date.now() > entry.deadlineAt) {
      this.expire(entry);
      throw new ApiException('CREATION_REQUEST_RESOLVED', '创建请求已超时（30s + 5s 宽限），决策拒收', undefined, {
        request_id: requestId,
        status: entry.status,
      });
    }

    if (decision.action === 'cancel') {
      await this.settleWithoutTask(entry, 'cancelled');
      return this.view(entry);
    }
    // edit 必带修改后载荷：REST 由 creationDecisionSchema 把关，服务层对直连调用者（测试/脚本）同口径兜底。
    if (decision.action === 'edit' && !decision.payload) {
      throw new ApiException('VALIDATION_FAILED', 'edit 决策必须携带修改后载荷（§8.7）', [
        { path: 'payload', code: 'required', message: '必填' },
      ]);
    }

    const draft: CreationDraft =
      decision.action === 'edit'
        ? await this.validate(decision.payload as ValidateInput, entry.draft)
        : entry.draft;
    const { taskId, unresolved } = await this.persistCreated(draft, entry.agentName, 'light', decision.action === 'edit' ? 'edited' : 'created', entry);
    entry.taskId = taskId;
    entry.unresolved = unresolved;
    this.close(entry, decision.action === 'edit' ? 'edited' : 'created');
    return this.view(entry);
  }

  // ---------------------------------------------------------------- 轻确认请求生命周期内部件

  /**
   * 造出待决请求、下发 WS 卡片、挂超时定时器。wait=true 时阻塞到收口（create_task 缺省语义）；
   * wait=false 立即返回 pending 结果（§8.7 r3 异步模式）。
   */
  private async requestConfirmation(
    draft: CreationDraft,
    agentName: string,
    source: 'mcp' | 'rest',
    mode: CreationMode,
    wait: boolean,
    duplicates?: CreationDuplicateHit[],
  ): Promise<CreateTaskToolResult> {
    const timeoutSeconds = await this.settings.get('light_confirm_timeout_seconds');
    const now = Date.now();
    let settled!: () => void;
    const done = new Promise<void>((resolve) => (settled = resolve));
    const entry: PendingRequest = {
      id: newId(),
      draft,
      agentName,
      source,
      confirmationMode: mode,
      status: 'pending',
      taskId: null,
      unresolved: [],
      duplicates: duplicates ?? (await this.findDuplicates(draft)),
      createdAt: now,
      expiresAt: now + timeoutSeconds * 1000,
      deadlineAt: now + timeoutSeconds * 1000 + DECISION_GRACE_MS,
      timer: undefined as unknown as NodeJS.Timeout,
      settled,
      done,
    };
    entry.timer = setTimeout(() => this.expire(entry).catch((err) => this.logger.warn(`超时收口失败: ${String(err)}`)), timeoutSeconds * 1000 + DECISION_GRACE_MS);
    entry.timer.unref?.();
    this.requests.set(entry.id, entry);
    this.pruneSettled();

    this.events.emit('agent.task_requested', this.view(entry) as unknown as Record<string, unknown>);
    // §13.9（r3）creation_request 规则键的「待处理」通知：待决期任务未落库，挂空 task_id
    // （notifications.task_id 有外键，请求 id 不能塞进去）；W9 前端铃铛已白名单此 kind。
    await this.notifications.push('creation_request', null, `🤖 ${agentName} 请求创建任务 · ${draft.title}`);

    if (!wait) {
      return {
        created: false,
        pending: true,
        request_id: entry.id,
        session_id: entry.draft.session_id,
        agent_name: agentName,
        confirmation_mode: 'light',
        expires_at: new Date(entry.expiresAt).toISOString(),
      };
    }
    await entry.done;
    return this.outcomeOf(entry);
  }

  /** 阻塞等待收口后的对外返回（§8.7：创建→带 task_id；取消/超时→不创建）。 */
  private outcomeOf(entry: PendingRequest): CreateTaskToolResult {
    if (entry.status === 'created' || entry.status === 'edited') {
      return {
        created: true,
        task_id: entry.taskId as string,
        request_id: entry.id,
        session_id: entry.draft.session_id,
        agent_name: entry.agentName,
        confirmation_mode: entry.confirmationMode,
        skill_resolution: { unresolved: entry.unresolved },
      };
    }
    return {
      created: false,
      request_id: entry.id,
      status: entry.status === 'timeout' ? 'timeout' : 'cancelled',
      session_id: entry.draft.session_id,
      agent_name: entry.agentName,
      confirmation_mode: 'light',
    };
  }

  /** 超时收口：35s（30+5）到点仍 pending → 记一条超时流水并「不创建」收口。 */
  private async expire(entry: PendingRequest): Promise<void> {
    if (entry.status !== 'pending') return;
    await this.settleWithoutTask(entry, 'timeout');
  }

  /** 取消/超时共用的否定收口：task_creation_logs 记一条（task_id 挂请求 id，见 0013 注释：无外键）。 */
  private async settleWithoutTask(entry: PendingRequest, action: 'cancelled' | 'timeout'): Promise<void> {
    await this.prisma.$executeRawUnsafe(
      `INSERT INTO task_creation_logs (task_id, session_id, agent_name, source, confirmation, user_action)
       VALUES (?, ?, ?, ?, 'light', ?)`,
      entry.id,
      entry.draft.session_id,
      entry.agentName,
      entry.source,
      action,
    );
    this.close(entry, action);
  }

  private close(entry: PendingRequest, status: CreationRequestStatus): void {
    entry.status = status;
    clearTimeout(entry.timer);
    entry.settled();
  }

  private pruneSettled(): void {
    const now = Date.now();
    for (const [id, entry] of this.requests) {
      if (entry.status !== 'pending' && now - entry.createdAt > SETTLED_TTL_MS) this.requests.delete(id);
    }
    if (this.requests.size > SETTLED_MAX) {
      const settled = [...this.requests.entries()]
        .filter(([, e]) => e.status !== 'pending')
        .sort((a, b) => a[1].createdAt - b[1].createdAt);
      for (const [id] of settled.slice(0, this.requests.size - SETTLED_MAX)) this.requests.delete(id);
    }
  }

  private view(entry: PendingRequest): CreationRequestView {
    return {
      request_id: entry.id,
      status: entry.status,
      task_id: entry.taskId,
      agent_name: entry.agentName,
      session_id: entry.draft.session_id,
      source: entry.source,
      title: entry.draft.title,
      description: entry.draft.description,
      group_id: entry.draft.group_id,
      type: entry.draft.type,
      priority: entry.draft.priority,
      tags: entry.draft.tags,
      skills: entry.draft.skills,
      duplicates: entry.duplicates,
      created_at: new Date(entry.createdAt).toISOString(),
      expires_at: new Date(entry.expiresAt).toISOString(),
      decision_deadline_at: new Date(entry.deadlineAt).toISOString(),
    };
  }

  // ---------------------------------------------------------------- 落库核心（三模式共用）

  /** 参数/设置校验 + 归一成内部草稿：light 的入参校验发生在请求生成时（§8.3「Board 校验」先于弹卡片）。 */
  private async validate(input: ValidateInput, base?: CreationDraft): Promise<CreationDraft> {
    const merged: ValidateInput = base
      ? ({ ...base, ...Object.fromEntries(Object.entries(input).filter(([, v]) => v !== undefined)) } as ValidateInput)
      : input;
    const title = (merged.title ?? '').trim();
    if (!title) {
      throw new ApiException('VALIDATION_FAILED', 'title 不能为空', [
        { path: 'title', code: 'too_small', message: '必填' },
      ]);
    }
    const type = (merged.type ?? '').trim();
    // 类型词表与 REST 同源（settings.task_types）；§8.8：需求不在此创建，走拆解流程。
    const types = await this.settings.get('task_types');
    if (!types.includes(type)) {
      throw new ApiException('VALIDATION_FAILED', `任务类型「${type}」不在词表内`, [
        { path: 'type', code: 'unknown_type', message: `可选：${types.join(' / ')}` },
      ]);
    }
    if (type === '需求') {
      throw new ApiException('VALIDATION_FAILED', '需求类型请走拆解流程（board.begin_breakdown），不经 create_task 直建', [
        { path: 'type', code: 'use_breakdown', message: '需求' },
      ]);
    }
    const groupId = merged.group_id ?? base?.group_id ?? DEFAULT_GROUP_ID;
    await this.assertActiveGroup(groupId);
    return {
      title,
      description: merged.description ?? null,
      group_id: groupId,
      type,
      priority: merged.priority ?? 3,
      tags: merged.tags ?? [],
      skills: merged.skills ?? [],
      session_id: merged.session_id?.trim() ? merged.session_id.trim() : null,
    };
  }

  /** direct/silent 即时落库：任务+会话+流水+审计单事务，随后广播 task.created。 */
  private async persistCreated(
    draft: CreationDraft,
    agentName: string,
    mode: CreationMode,
    userAction: CreationUserAction = 'created',
    request?: PendingRequest,
  ): Promise<{ taskId: string; unresolved: string[] }> {
    // 技能解析（§7.5 r3 口径）：值已是 id 直通；否则按 name 精确匹配取最近更新者；
    // 无命中的丢弃并进 skill_resolution——与拆解确认页一样，不因坏引用阻断创建。
    const { skillIds, unresolved } = await this.resolveSkills(draft.skills);
    const skillsJson =
      skillIds.length === 0 ? '[]' : await this.skills.normalizeTaskBindings(skillIds.map((id) => ({ skill_id: id })));

    const taskId = await this.prisma.$transaction(async (tx) => {
      const id = await nextTaskId(tx);
      await tx.$executeRawUnsafe(
        `INSERT INTO tasks (id, group_id, type, title, description, status, priority, tags, skills,
                            origin_type, origin_agent, origin_session_id, confirmation_mode)
         VALUES (?, ?, ?, ?, ?, 'BACKLOG', ?, ?, ?, 'agent', ?, ?, ?)`,
        id,
        draft.group_id,
        draft.type,
        draft.title,
        draft.description,
        draft.priority,
        JSON.stringify(draft.tags),
        skillsJson,
        agentName,
        draft.session_id,
        mode,
      );
      // §8.7：按 session_id upsert——首见建会话（started_at/last_active_at 吃列默认值，
      // 首条创建即计 1），再见刷新活跃时刻并计数；task_count 只在真正建成任务时 +1（本事务内）。
      // REST 生成的请求可能无会话：会话记账只属于有 session 的 MCP 链路。
      if (draft.session_id) {
        await tx.$executeRawUnsafe(
          `INSERT INTO agent_sessions (id, session_id, agent_name, task_count) VALUES (?, ?, ?, 1)
           ON CONFLICT(session_id) DO UPDATE SET
             last_active_at = datetime('now'),
             task_count = agent_sessions.task_count + 1`,
          newId(),
          draft.session_id,
          agentName,
        );
      }
      // §8.7：每次创建/取消/超时各记一条流水；light 路径 created/edited 也在决策事务内补记。
      await tx.$executeRawUnsafe(
        `INSERT INTO task_creation_logs (task_id, session_id, agent_name, source, confirmation, user_action)
         VALUES (?, ?, ?, ?, ?, ?)`,
        id,
        draft.session_id,
        agentName,
        request?.source ?? 'mcp',
        mode,
        userAction,
      );
      await this.audit.record(
        {
          actorType: 'agent',
          actorName: agentName,
          action: 'task_create',
          targetType: 'task',
          targetId: id,
          after: { id, type: draft.type, title: draft.title, origin: 'agent', confirmation_mode: mode },
        },
        tx,
      );
      return id;
    });

    // §8.6：direct/silent 直建的任务是 agent 来源——载荷 origin_type 供前端挂 5 秒撤销入口。
    this.events.emit('task.created', { id: taskId, origin_type: 'agent' });
    // §8.2/§13.9：静默模式「不弹确认卡片、仅发通知」，直接/静默创建成功同走 creation_request
    // 规则键（direct 弹不弹卡片都不影响这条站内通知，§8.8「创建后通知」）。
    if (mode === 'direct' || mode === 'silent') {
      await this.notifications.push('creation_request', taskId, `🤖 ${agentName} 已创建任务 ${taskId} · ${draft.title}`);
    }
    return { taskId, unresolved };
  }

  // ---------------------------------------------------------------- 重复检测（§8.5）

  /** 标题归一化 + 词集 Jaccard > 0.8，限同分组、5 分钟窗口；纯本地计算不调模型。 */
  private async findDuplicates(draft: CreationDraft): Promise<CreationDuplicateHit[]> {
    const tokens = titleTokens(draft.title);
    if (tokens.size === 0) return [];
    const rows = await this.prisma.$queryRawUnsafe<{ id: string; title: string }[]>(
      `SELECT id, title FROM tasks WHERE group_id = ? AND created_at >= datetime('now', ?)`,
      draft.group_id,
      DUP_WINDOW_SQL,
    );
    // 同窗口内的其它待决请求也算疑似重复（Agent 连发同文时任务还没落库）。
    const pendingTitles = [...this.requests.values()]
      .filter((e) => e.status === 'pending' && e.draft.group_id === draft.group_id)
      .map((e) => ({ id: `req:${e.id}`, title: e.draft.title }));
    const hits: CreationDuplicateHit[] = [];
    for (const row of [...rows, ...pendingTitles]) {
      const similarity = jaccard(tokens, titleTokens(row.title));
      if (similarity > DUP_SIMILARITY) hits.push({ task_id: row.id, title: row.title, similarity: Number(similarity.toFixed(2)) });
    }
    return hits.sort((a, b) => b.similarity - a.similarity).slice(0, 3);
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

/**
 * §8.5 标题归一化后的「词集」：汉字按相邻双字成词（bigram，中文没有空格分词），
 * 连续字母/数字整段成词；空白与标点先剥离、统一小写。
 */
function titleTokens(title: string): Set<string> {
  const normalized = title.toLowerCase().replace(/[^\p{Script=Han}\p{L}\p{N}]+/gu, '');
  const tokens = new Set<string>();
  for (const run of normalized.match(/[\u4e00-\u9fff]+|[a-z0-9]+/g) ?? []) {
    if (/[\u4e00-\u9fff]/.test(run[0] as string)) {
      if (run.length === 1) tokens.add(run);
      for (let i = 0; i + 1 < run.length; i++) tokens.add(run.slice(i, i + 2));
    } else {
      tokens.add(run);
    }
  }
  return tokens;
}

function jaccard(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 || b.size === 0) return 0;
  let shared = 0;
  for (const token of a) if (b.has(token)) shared++;
  return shared / (a.size + b.size - shared);
}
