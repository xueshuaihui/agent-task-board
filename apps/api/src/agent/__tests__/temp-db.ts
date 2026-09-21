import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { Prisma } from '@prisma/client';
import { newId } from '../../contract/ids';
import type { RequestAuth } from '../../auth/auth.scope';
import { applyMigrations } from '../../infra/bootstrap';
import { AuditService } from '../../infra/audit.service';
import { EventsService, type WsEvent } from '../../infra/events.service';
import { NotificationsService } from '../../infra/notifications.service';
import { PrismaService } from '../../infra/prisma.service';
import { SettingsService } from '../../infra/settings.service';
import { AgentQueryService } from '../agent-query.service';
import { BreakdownService } from '../../breakdown/breakdown.service';
import { CreationService } from '../../creation/creation.service';
import { SkillsService } from '../../skills/skills.service';
import { ClaimService } from '../claim.service';
import { LeaseService } from '../lease.service';
import { McpPolicyService } from '../mcp-policy.service';
import { WritebackService } from '../writeback.service';

/**
 * 每个测试文件一个独立临时库：ATB_DATA_DIR 指到 mkdtemp 目录后 PrismaService 的连接串
 * 就落在该目录的 jarvis.db 上，绝不连共享的 apps/api/prisma/dev.db（并行开发的同事都在写那张表）。
 * 建表直接跑 prisma/migrations 的权威 DDL，含 11 章手写的部分唯一索引 uniq_active_run——
 * 它不在 schema.prisma 里，用 `db push` 生成的库反而测不出认领的兜底行为。
 */
export interface AgentHarness {
  dir: string;
  prisma: PrismaService;
  settings: SettingsService;
  events: EventsService;
  emitted: WsEvent[];
  leases: LeaseService;
  query: AgentQueryService;
  claims: ClaimService;
  writeback: WritebackService;
  /** W6 §16.1：技能三工具的上下文需要 SkillsService（与 query 内部是同一实例）。 */
  skills: SkillsService;
  /** W6 §12.6：策略两工具（check_mcp_policy / report_mcp_call）的上下文。 */
  policy: McpPolicyService;
  /** W7 §16.1：board.* 拆解五工具的上下文（与 REST 确认页同一服务层实现）。 */
  breakdown: BreakdownService;
  /** W8 §8.7：board.create_task 的会话创建闭环上下文（直建/静默；light 占位）。 */
  creation: CreationService;
  /** 造一个 Agent 凭证：只返回服务层真正用到的那部分（tokenId / name / capabilities）。 */
  agent(name: string, capabilities?: string[]): Promise<RequestAuth>;
  dispose: () => Promise<void>;
}

export function createAgentHarness(): AgentHarness {
  const dir = mkdtempSync(path.join(tmpdir(), 'atb-agent-'));
  process.env.ATB_DATA_DIR = dir;
  applyMigrations();

  const prisma = new PrismaService();
  const settings = new SettingsService(prisma);
  const audit = new AuditService(prisma);
  const events = new EventsService();
  const emitted: WsEvent[] = [];
  events.registerSink((event) => emitted.push(event));
  const notifications = new NotificationsService(prisma, events);

  const leases = new LeaseService(prisma, settings, audit, events, notifications);
  const skills = new SkillsService(prisma);
  const query = new AgentQueryService(prisma, skills);
  const claims = new ClaimService(prisma, settings, leases, audit, events, query);
  const writeback = new WritebackService(prisma, leases, audit, events, notifications, query);
  const policy = new McpPolicyService(prisma, audit);
  const breakdown = new BreakdownService(prisma, audit, events);
  const creation = new CreationService(prisma, settings, audit, events, skills);

  return {
    dir,
    prisma,
    settings,
    events,
    emitted,
    // 不触发 onModuleInit：扫描器由过期回收用例显式启动，其余用例手工调 reclaimExpired()。
    leases,
    query,
    claims,
    writeback,
    skills,
    policy,
    breakdown,
    creation,
    agent: async (name: string, capabilities: string[] = []) => {
      const id = newId();
      await prisma.apiToken.create({
        data: { id, name, tokenHash: `hash-${id}`, capabilities: JSON.stringify(capabilities) },
      });
      return { kind: 'agent', tokenId: id, tokenName: name, capabilities };
    },
    dispose: async () => {
      leases.stopSweeper();
      await prisma.$disconnect();
      rmSync(dir, { force: true, recursive: true });
    },
  };
}

/** 造任务：READY 是可认领态，绝大多数用例从它出发。 */
export async function seedTask(
  prisma: PrismaService,
  id: string,
  overrides: Partial<Prisma.TaskUncheckedCreateInput> & {
    required_capabilities?: string[];
  } = {},
): Promise<string> {
  const { required_capabilities, ...rest } = overrides;
  await prisma.task.create({
    data: {
      id,
      title: `${id} 标题`,
      status: 'READY',
      ...rest,
      ...(required_capabilities
        ? { requiredCapabilities: JSON.stringify(required_capabilities) }
        : {}),
    },
  });
  return id;
}

/** 把租约改到过去：SQLite 只有 `datetime('now')` 是服务端时钟，测试无法伪造时间，只能倒填。 */
export async function backdateLease(
  prisma: PrismaService,
  taskId: string,
  modifier = '-31 minutes',
): Promise<void> {
  await prisma.$executeRawUnsafe(
    `UPDATE tasks SET lease_expires_at = datetime('now', ?) WHERE id = ?`,
    modifier,
    taskId,
  );
}

/** 认领结果的三元组，写回用例全靠它。 */
export function tripleOf(result: {
  task: { id: string } | null;
  lease?: { run_id: string; lease_id: string };
}) {
  if (!result.task || !result.lease) throw new Error('用例期望认领成功');
  return {
    task_id: result.task.id,
    run_id: result.lease.run_id,
    lease_id: result.lease.lease_id,
  };
}
