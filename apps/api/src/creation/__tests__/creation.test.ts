import { cpSync, mkdirSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { RequestAuth } from '../../auth/auth.scope';
import { applyMigrations, migrationsDir } from '../../infra/bootstrap';
import { callAgentTool } from '../../mcp/mcp.server';
import { createAgentHarness, type AgentHarness } from '../../agent/__tests__/temp-db';
import { skillCreateSchema } from '../../skills/skills.dto';

/**
 * v0.0.4 W8 第一片（§8.7）：board.create_task 直建/静默两模式 + 会话/流水落库。
 * 覆盖三层：
 *  1. 迁移 0013 演练——在 /tmp 里从 0012 水位增量升级到 0013（真库禁写，一律临时目录）；
 *  2. 服务/MCP 面：两模式成功路径的任务 origin 列、agent_sessions upsert、
 *     task_creation_logs/audit_logs 行数断言；
 *  3. light 占位：NOT_IMPLEMENTED(501)，且不产生任何落库副作用。
 */
let h: AgentHarness;
let agent: RequestAuth;
const ui: RequestAuth = { kind: 'ui' };

const toolCtx = () => ({
  claims: h.claims,
  leases: h.leases,
  writeback: h.writeback,
  query: h.query,
  skills: h.skills,
  policy: h.policy,
  breakdown: h.breakdown,
  creation: h.creation,
});

function call(name: string, args: Record<string, unknown>, auth: RequestAuth = agent) {
  return callAgentTool(toolCtx(), auth, name, args);
}

async function countOf(table: string, where = '', params: unknown[] = []): Promise<number> {
  const rows = await h.prisma.$queryRawUnsafe<{ n: number }[]>(
    `SELECT COUNT(*) AS n FROM ${table} ${where}`,
    ...params,
  );
  return Number(rows[0]!.n);
}

const baseInput = {
  title: '修复登录页面的空指针异常',
  description: '登录页在 session 为空时抛 NPE',
  type: '缺陷',
  priority: 1,
  tags: ['后端'],
  session_id: 'conv-20260920-001',
  agent_name: 'qoder-1',
};

beforeAll(async () => {
  h = createAgentHarness();
  agent = await h.agent('qoder-w8', []);
});

afterAll(async () => {
  await h?.dispose();
});

// ---------------------------------------------------------------- 1. 迁移 0013 演练

describe('迁移 0013 演练（/tmp 临时库，当前水位 0012 → 0013）', () => {
  it('水位 0012 的库增量应用 0013：只重放 0013，新表与 tasks 来源列就位', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'atb-w8-mig-'));
    const previous = { data: process.env.ATB_DATA_DIR, mig: process.env.ATB_MIGRATIONS_DIR };
    try {
      process.env.ATB_DATA_DIR = dir;
      // 1) 用 0001~0012 迁移子集全量重放：造出「当前水位 0012」的既有库（真库禁写）。
      const staged = path.join(dir, 'migrations-0012');
      mkdirSync(staged);
      const source = migrationsDir();
      for (const entry of readdirSync(source)) {
        if (/^\d+_/.test(entry) && Number(entry.split('_')[0]) <= 12) {
          cpSync(path.join(source, entry), path.join(staged, entry), { recursive: true });
        }
      }
      process.env.ATB_MIGRATIONS_DIR = staged;
      const upTo12 = applyMigrations();
      expect(upTo12[upTo12.length - 1]).toBe(12);

      // 2) 切回全量迁移目录：应只增量应用 0013。
      delete process.env.ATB_MIGRATIONS_DIR;
      const applied = applyMigrations();
      expect(applied).toEqual([13]); // 0001~0012 不重放

      const check = new DatabaseSync(path.join(dir, 'jarvis.db'), { readOnly: true });
      const version = check.prepare('PRAGMA user_version').get() as { user_version: number };
      expect(version.user_version).toBe(13);
      const tables = check
        .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name IN ('agent_sessions','task_creation_logs')")
        .all() as { name: string }[];
      expect(tables.map((row) => row.name).sort()).toEqual(['agent_sessions', 'task_creation_logs']);
      const taskColumns = new Set(
        (check.prepare('PRAGMA table_info(tasks)').all() as { name: string }[]).map((row) => row.name),
      );
      for (const column of ['origin_type', 'origin_agent', 'origin_skill', 'origin_session_id', 'confirmation_mode']) {
        expect(taskColumns.has(column)).toBe(true);
      }
      // 升级前已存在的任务行吃常量默认 'user'（演练库此刻还没有行，用显式插入验证默认值语义）。
      check.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
      if (previous.data === undefined) delete process.env.ATB_DATA_DIR;
      else process.env.ATB_DATA_DIR = previous.data;
      if (previous.mig === undefined) delete process.env.ATB_MIGRATIONS_DIR;
      else process.env.ATB_MIGRATIONS_DIR = previous.mig;
    }
  });

  it('列语义落库校验：origin_type 默认 user、CHECK 词表、session_id 唯一', async () => {
    const seedId = await h.prisma.$queryRawUnsafe<{ id: string }[]>(
      `SELECT 'mig_probe' AS id`,
    );
    expect(seedId[0]!.id).toBe('mig_probe');
    // 无 origin_type 的插入吃列默认 'user'（存量/非 Agent 入口天然来源）。
    await h.prisma.$executeRawUnsafe(
      `INSERT INTO tasks (id, type, title) VALUES ('mig_t1', '缺陷', '默认来源')`,
    );
    const row = await h.prisma.$queryRawUnsafe<{ origin_type: string | null }[]>(
      `SELECT origin_type FROM tasks WHERE id = 'mig_t1'`,
    );
    expect(row[0]!.origin_type).toBe('user');
    // origin_type / confirmation_mode 词表 CHECK 生效。
    await expect(
      h.prisma.$executeRawUnsafe(
        `INSERT INTO tasks (id, type, title, origin_type) VALUES ('mig_t2', '缺陷', 'x', 'robot')`,
      ),
    ).rejects.toThrow();
    await expect(
      h.prisma.$executeRawUnsafe(
        `INSERT INTO tasks (id, type, title, confirmation_mode) VALUES ('mig_t3', '缺陷', 'x', 'whisper')`,
      ),
    ).rejects.toThrow();
    // agent_sessions 按 session_id 唯一（§8.7 upsert 坐标）。
    await h.prisma.$executeRawUnsafe(
      `INSERT INTO agent_sessions (id, session_id, agent_name) VALUES ('as_m1', 'conv-mig', 'a')`,
    );
    await expect(
      h.prisma.$executeRawUnsafe(
        `INSERT INTO agent_sessions (id, session_id, agent_name) VALUES ('as_m2', 'conv-mig', 'b')`,
      ),
    ).rejects.toThrow();
  });
});

// ---------------------------------------------------------------- 2. 直建 / 静默两模式

describe('board.create_task 直接创建（direct）', () => {
  let taskId: string;

  it('成功：任务落库带 agent 来源五列，会话/流水/审计各一行，task.created 事件发出', async () => {
    const skill = await h.skills.create(
      skillCreateSchema.parse({ name: '单元测试', type: 'prompt', description: '', tags: [], mcp_dependencies: [] }),
    );
    const before = h.emitted.filter((e) => e.event === 'task.created').length;

    const result = (await call('board.create_task', {
      ...baseInput,
      skills: [skill.id, '单元测试', '查无此技能'],
      confirmation_mode: 'direct',
    })) as {
      created: boolean;
      task_id: string;
      session_id: string;
      agent_name: string;
      confirmation_mode: string;
      skill_resolution: { unresolved: string[] };
    };
    taskId = result.task_id;
    expect(result).toMatchObject({
      created: true,
      session_id: baseInput.session_id,
      agent_name: 'qoder-1',
      confirmation_mode: 'direct',
    });
    // §7.5 同口径：id 直通、name 解析、坏引用丢弃不阻断（回显告警）。
    expect(result.skill_resolution.unresolved).toEqual(['查无此技能']);

    const tasks = await h.prisma.$queryRawUnsafe<Record<string, unknown>[]>(
      `SELECT group_id, status, priority, tags, skills, origin_type, origin_agent, origin_session_id, confirmation_mode
         FROM tasks WHERE id = ?`,
      taskId,
    );
    const task = tasks[0]!;
    expect(task).toMatchObject({
      group_id: 'grp_default', // 未指定分组落默认组（§5.2，与 REST 同兜底）
      status: 'BACKLOG',
      priority: 1,
      origin_type: 'agent',
      origin_agent: 'qoder-1',
      origin_session_id: baseInput.session_id,
      confirmation_mode: 'direct',
    });
    const bindings = JSON.parse(task.skills as string) as { skill_id: string; version: string }[];
    // id 与解析到同一技能的 name 去重成一枚；存储形状与 REST 一致（{skill_id, version}）。
    expect(bindings.map((b) => b.skill_id)).toEqual([skill.id]);
    expect(bindings.every((b) => b.version === 'v0.1.0')).toBe(true); // 与 REST 同存储形状（带版本）

    const sessions = await h.prisma.$queryRawUnsafe<{ task_count: number }[]>(
      `SELECT task_count FROM agent_sessions WHERE session_id = ?`,
      baseInput.session_id,
    );
    expect(sessions).toHaveLength(1);
    expect(sessions[0]!.task_count).toBe(1); // 首见建会话即计 1（upsert 的 INSERT 分支）
    expect(await countOf('task_creation_logs', 'WHERE task_id = ?', [taskId])).toBe(1);
    expect(await countOf('audit_logs', "WHERE action = 'task_create' AND target_id = ?", [taskId])).toBe(1);
    const log = await h.prisma.$queryRawUnsafe<Record<string, unknown>[]>(
      `SELECT source, confirmation, user_action, agent_name, session_id FROM task_creation_logs WHERE task_id = ?`,
      taskId,
    );
    expect(log[0]).toMatchObject({
      source: 'mcp',
      confirmation: 'direct',
      user_action: 'created',
      agent_name: 'qoder-1',
      session_id: baseInput.session_id,
    });
    expect(h.emitted.filter((e) => e.event === 'task.created').length).toBe(before + 1);
  });
});

describe('board.create_task 静默创建（silent）+ 会话刷新', () => {
  it('同会话再创建：agent_sessions 仍一行、task_count 递增、流水各记一条', async () => {
    const result = (await call('board.create_task', {
      title: '补充登录回归用例',
      type: '缺陷',
      session_id: 'conv-20260920-001',
      agent_name: 'qoder-1',
      confirmation_mode: 'silent',
    })) as { task_id: string };

    const sessions = await h.prisma.$queryRawUnsafe<{ task_count: number; last_active_at: string }[]>(
      `SELECT task_count, last_active_at FROM agent_sessions WHERE session_id = 'conv-20260920-001'`,
    );
    expect(sessions).toHaveLength(1);
    expect(sessions[0]!.task_count).toBe(2); // §8.7：每次创建刷新 last_active_at/task_count
    expect(sessions[0]!.last_active_at).toBeTruthy();
    expect(await countOf('task_creation_logs', 'WHERE session_id = ?', ['conv-20260920-001'])).toBe(2);
    expect(await countOf('tasks', 'WHERE origin_session_id = ?', ['conv-20260920-001'])).toBe(2);
    const task = await h.prisma.$queryRawUnsafe<{ confirmation_mode: string }[]>(
      `SELECT confirmation_mode FROM tasks WHERE id = ?`,
      result.task_id,
    );
    expect(task[0]!.confirmation_mode).toBe('silent');
  });

  it('agent_name 缺省取凭证名（同 begin_breakdown 口径）', async () => {
    const result = (await call('board.create_task', {
      title: '无署名创建',
      type: '缺陷',
      session_id: 'conv-unsigned',
      confirmation_mode: 'direct',
    })) as { agent_name: string };
    expect(result.agent_name).toBe('qoder-w8');
    const rows = await h.prisma.$queryRawUnsafe<{ agent_name: string }[]>(
      `SELECT agent_name FROM agent_sessions WHERE session_id = 'conv-unsigned'`,
    );
    expect(rows[0]!.agent_name).toBe('qoder-w8');
  });
});

// ---------------------------------------------------------------- 3. light 占位与校验

describe('board.create_task light 占位（决策闭环归下一切片）', () => {
  it('confirmation_mode=light → NOT_IMPLEMENTED(501)，零落库副作用', async () => {
    const logsBefore = await countOf('task_creation_logs');
    const sessionsBefore = await countOf('agent_sessions');
    await expect(
      call('board.create_task', { ...baseInput, session_id: 'conv-light', confirmation_mode: 'light' }),
    ).rejects.toMatchObject({ code: 'NOT_IMPLEMENTED', status: 501 });
    expect(await countOf('task_creation_logs')).toBe(logsBefore);
    expect(await countOf('agent_sessions')).toBe(sessionsBefore);
    expect(await countOf('agent_sessions', 'WHERE session_id = ?', ['conv-light'])).toBe(0);
  });

  it('缺省 confirmation_mode 按默认轻确认解析（§8.2）→ 同样 NOT_IMPLEMENTED', async () => {
    const input = { ...baseInput, session_id: 'conv-default' };
    delete (input as { confirmation_mode?: string }).confirmation_mode;
    await expect(call('board.create_task', input)).rejects.toMatchObject({
      code: 'NOT_IMPLEMENTED',
    });
  });
});

describe('board.create_task 校验与鉴权', () => {
  it('UI 凭证调用 → FORBIDDEN（Agent 凭证专属）', async () => {
    await expect(call('board.create_task', baseInput, ui)).rejects.toMatchObject({ code: 'FORBIDDEN' });
  });

  it('类型不在词表 / 需求走拆解 / 未知分组 / 空标题各归各错', async () => {
    await expect(
      call('board.create_task', { ...baseInput, type: '太空类型', confirmation_mode: 'direct' }),
    ).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
    await expect(
      call('board.create_task', { ...baseInput, type: '需求', confirmation_mode: 'direct' }),
    ).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
    await expect(
      call('board.create_task', { ...baseInput, group_id: 'grp_missing', confirmation_mode: 'direct' }),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
    await expect(
      call('board.create_task', { ...baseInput, title: '  ', confirmation_mode: 'direct' }),
    ).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
  });
});
