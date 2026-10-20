import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { RequestAuth } from '../../auth/auth.scope';
import { buildAgentTools } from '../../mcp/agent-tools';
import { callAgentTool, createAgentMcpServer, MCP_SERVER_NAME } from '../../mcp/mcp.server';
import { skillCreateSchema, type SkillCreateInput, type SkillOrigin } from '../../skills/skills.dto';
import { createAgentHarness, seedTask, type AgentHarness } from './temp-db';

/**
 * MCP 侧只测「工具面」：名字集合、tools/list 的入参 schema、以及 12 章通用契约要求的
 * `isError: true` + `structuredContent.code`。业务分支已在 writeback.test.ts 覆盖，
 * 这里走一遍真实的 Client ↔ Server 内存传输，确保 SDK 的参数校验与我们的错误载荷没被架空。
 */
let h: AgentHarness;
let agent: RequestAuth;
let client: Client;

/**
 * §12 + §16.1 已落地子集（9 基础 + W6 的 block_task / wait_for_resume / 技能三工具 / 策略二工具
 * + W7 的 board.* 拆解五工具 + #4 追加的 board.get_breakdown / board.wait_for_breakdown
 * + W8-a2 的创建闭环三工具
 * （board.create_task / get_creation_status / wait_for_confirmation，§8.7 r3）
 * + W8-a3 的 board.create_tasks_batch（§8.7 批量轻量版）
 * + B6 的 get_vocabulary（词表只读）+ §16.1 的 update_task / update_skill（全字段 PATCH：
 * 任务侧守卫三支、技能侧复用 SkillsService.patch 的只读与引用环守卫）。
 * 顺序不敏感但一条都不能多、不能少。
 */
const W6_TOOL_NAMES = [
  'append_log',
  'block_task',
  'board.begin_breakdown',
  'board.cancel_breakdown',
  'board.create_task',
  'board.create_tasks_batch',
  'board.finish_breakdown',
  'board.get_breakdown',
  'board.get_creation_status',
  'board.report_progress',
  'board.report_task_draft',
  'board.wait_for_breakdown',
  'board.wait_for_confirmation',
  'check_mcp_policy',
  'claim_next_task',
  'complete_task',
  'create_skill',
  'fail_task',
  'get_review_feedback',
  'get_skill',
  'get_task',
  'get_vocabulary',
  'heartbeat',
  'list_ready_tasks',
  'list_skills',
  'report_mcp_call',
  'search_skills',
  'update_progress',
  'update_skill',
  'update_task',
  'wait_for_resume',
];

beforeAll(async () => {
  h = createAgentHarness();
  agent = await h.agent('mcp-client', ['tool:git']);

  const server = createAgentMcpServer(agent, {
    claims: h.claims,
    leases: h.leases,
    writeback: h.writeback,
    query: h.query,
    skills: h.skills,
    policy: h.policy,
    breakdown: h.breakdown,
    creation: h.creation,
    settings: h.settings,
  });
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  await server.connect(serverSide);
  client = new Client({ name: 'test-client', version: '0.0.0' });
  await client.connect(clientSide);
});

afterAll(async () => {
  await client?.close().catch(() => undefined);
  await h.dispose();
});

beforeEach(async () => {
  await h.prisma.artifact.deleteMany();
  await h.prisma.notification.deleteMany();
  await h.prisma.auditLog.deleteMany();
  await h.prisma.comment.deleteMany();
  await h.prisma.taskRun.deleteMany();
  await h.prisma.task.deleteMany();
  await h.prisma.skillVersion.deleteMany();
  await h.prisma.skill.deleteMany();
});

/** SDK 的返回类型是 CallToolResult 与兼容体的联合，这里按 12 章真正用到的三个字段收窄。 */
interface ToolResult {
  content: { type: string; text: string }[];
  structuredContent?: Record<string, unknown>;
  isError?: boolean;
}

async function call(name: string, args: Record<string, unknown> = {}): Promise<ToolResult> {
  return (await client.callTool({ name, arguments: args })) as unknown as ToolResult;
}

function structured(result: ToolResult) {
  return result.structuredContent;
}

describe('MCP 工具面', () => {
  it('tools/list 暴露 12 章基础工具、W6 技能/策略工具与 W7 board.* 拆解工具，都带 JSON Schema', async () => {
    const { tools } = await client.listTools();
    expect(tools.map((tool) => tool.name).sort()).toEqual(W6_TOOL_NAMES);
    expect(MCP_SERVER_NAME).toBe('jarvis-workbench');
    for (const tool of tools) {
      expect(tool.description).toBeTruthy();
      expect(tool.inputSchema.type).toBe('object');
    }
    const claim = tools.find((tool) => tool.name === 'claim_next_task');
    expect(Object.keys(claim?.inputSchema.properties ?? {})).toEqual(['capabilities', 'task_types']);
    const complete = tools.find((tool) => tool.name === 'complete_task');
    expect(Object.keys(complete?.inputSchema.properties ?? {}).sort()).toEqual([
      'artifacts',
      'lease_id',
      'output',
      'run_id',
      'summary',
      'task_id',
    ]);
    // §7.2 阶段 1：begin 的 JSON Schema 形状锁死（客户端侧配置/文档以此为契约）。
    const begin = tools.find((tool) => tool.name === 'board.begin_breakdown');
    expect(Object.keys(begin?.inputSchema.properties ?? {}).sort()).toEqual([
      'agent_name',
      'estimated_tasks',
      'group_id',
      'parent_description',
      'parent_title',
      'requirement_text',
      'skill_used',
    ]);
  });

  it('claim_next_task 经 MCP 返回 task + lease，并真的建立租约', async () => {
    await seedTask(h.prisma, 'T-1');
    const result = await call('claim_next_task');

    const payload = structured(result)!;
    expect(result.isError).toBeUndefined();
    expect((payload.task as { id: string }).id).toBe('T-1');
    const lease = payload.lease as { run_id: string; lease_id: string; expires_at: string };
    expect(lease.run_id).toMatch(/^R-\d+$/);
    expect((await h.prisma.task.findUniqueOrThrow({ where: { id: 'T-1' } })).leaseId).toBe(
      lease.lease_id,
    );
  });

  it('写回错误以 isError + structuredContent.code 承载同一份 13 章错误码', async () => {
    const error = await call('complete_task', {
      task_id: 'T-1',
      run_id: 'R-999',
      lease_id: '01947c3e-6f2a-7a11-9c31-8d5f2e1b7c40',
      summary: '没认领就想回写',
    });

    expect(error.isError).toBe(true);
    expect(structured(error)).toMatchObject({ code: 'TASK_GONE', task_id: 'T-1', run_id: 'R-999' });
    expect(error.content[0]!.text).toContain('TASK_GONE');
    expect(await h.prisma.taskRun.count()).toBe(0);
  });

  it('三元组校验失败时回 LEASE_EXPIRED 而不是 500', async () => {
    await seedTask(h.prisma, 'T-1');
    const claimed = structured(await call('claim_next_task'))!;
    const lease = claimed.lease as { run_id: string; lease_id: string };

    const result = await call('update_progress', {
      task_id: 'T-1',
      run_id: lease.run_id,
      lease_id: '00000000-0000-4000-8000-000000000000',
      progress: 50,
    });
    expect(result.isError).toBe(true);
    expect(structured(result)!.code).toBe('LEASE_EXPIRED');
    expect((await h.prisma.taskRun.findUniqueOrThrow({ where: { id: lease.run_id } })).progress).toBeNull();
  });

  it('get_review_feedback 与 get_task 是只读工具，不需要三元组', async () => {
    await seedTask(h.prisma, 'T-1');
    const task = await call('get_task', { task_id: 'T-1' });
    expect(structured(task)!.task).toMatchObject({ id: 'T-1', status: 'READY' });

    const feedback = await call('get_review_feedback', { task_id: 'T-1', limit: 3 });
    expect(structured(feedback)).toEqual({ review_feedback: [] });
    expect(await h.prisma.taskRun.count()).toBe(0);
  });

  it('结构不合法的入参在 SDK 层就被挡（协议错误只有 isError，没有 13 章的 code）', async () => {
    const result = await call('heartbeat', { task_id: 'T-1' });

    expect(result.isError).toBe(true);
    expect(result.content[0]!.text).toContain('-32602');
    expect(result.content[0]!.text).toContain('Input validation error');
    // 语义错误（410/409/422）才有 structuredContent.code —— 结构错误到不了我们的 handler。
    expect(result.structuredContent).toBeUndefined();
    expect(await h.prisma.taskRun.count()).toBe(0);
  });

  it('工具表与服务层一一对应：MCP 不复制业务逻辑', () => {
    expect(buildAgentTools({ claims: h.claims, leases: h.leases, writeback: h.writeback, query: h.query, skills: h.skills, policy: h.policy, breakdown: h.breakdown, creation: h.creation, settings: h.settings }).map((tool) => tool.name).sort()).toEqual(
      W6_TOOL_NAMES,
    );
  });

  // ------------------------------------------------------------ v0.0.4 W6 §16.1：block_task / wait_for_resume

  it('block_task 走同一 writeback.blocked：任务转 BLOCKED、租约清空、Run 收口 FAILED', async () => {
    await seedTask(h.prisma, 'T-1');
    const claimed = structured(await call('claim_next_task'))!;
    const lease = claimed.lease as { run_id: string; lease_id: string };

    const blocked = await call('block_task', {
      task_id: 'T-1',
      run_id: lease.run_id,
      lease_id: lease.lease_id,
      block_id: 'h1',
      block_title: '需要产品确认',
      instruction: '请确认字段规则后回 READY',
    });
    expect(structured(blocked)).toMatchObject({
      task_id: 'T-1',
      run_id: lease.run_id,
      task_status: 'BLOCKED',
      idempotent: false,
      orphaned: false,
    });
    const stored = await h.prisma.task.findUniqueOrThrow({ where: { id: 'T-1' } });
    expect([stored.status, stored.leaseId, stored.leaseExpiresAt, stored.currentRunId]).toEqual([
      'BLOCKED',
      null,
      null,
      null,
    ]);
    const run = await h.prisma.taskRun.findUniqueOrThrow({ where: { id: lease.run_id } });
    expect([run.status, run.error]).toEqual(['FAILED', '人工块「需要产品确认」等待人工处理：请确认字段规则后回 READY']);
  });

  it('block_task 需要三元组：非持有租约时回 LEASE_EXPIRED/TASK_GONE', async () => {
    const err = await call('block_task', {
      task_id: 'T-9',
      run_id: 'R-1',
      lease_id: '01947c3e-6f2a-7a11-9c31-8d5f2e1b7c40',
      block_id: 'h1',
      block_title: '',
      instruction: '没认领就想 block',
    });
    expect(err.isError).toBe(true);
    expect(structured(err)!.code).toBe('TASK_GONE');
  });

  it('wait_for_resume 只读：任务非 BLOCKED 时立即回，resumed=false / timed_out=false', async () => {
    await seedTask(h.prisma, 'T-1'); // READY
    const result = await call('wait_for_resume', { task_id: 'T-1', timeout_seconds: 5 });
    expect(structured(result)).toMatchObject({
      task_id: 'T-1',
      status: 'READY',
      resumed: false,
      timed_out: false,
      waited_seconds: 0,
    });
    expect(await h.prisma.taskRun.count()).toBe(0);
  });

  it('wait_for_resume 命中 BLOCKED→READY 的 task.moved 事件即解挂，resumed=true', async () => {
    await seedTask(h.prisma, 'T-1');
    const claimed = structured(await call('claim_next_task'))!;
    const lease = claimed.lease as { run_id: string; lease_id: string };
    await call('block_task', {
      task_id: 'T-1',
      run_id: lease.run_id,
      lease_id: lease.lease_id,
      block_id: 'h1',
      block_title: '人工确认',
      instruction: '等人工',
    });

    // 30ms 后模拟 tasks.service.transition 的 BLOCKED→READY 广播：先落库再 emit，
    // 与生产实现（`setStatus` 先完成，`emit('task.moved')` 后发）同序，避免与 waitResume
    // 里事件唤醒后再读一次的语义打架。
    setTimeout(() => {
      void h.prisma.task
        .update({ where: { id: 'T-1' }, data: { status: 'READY' } })
        .then(() => h.events.emit('task.moved', { id: 'T-1', from: 'BLOCKED', to: 'READY' }));
    }, 30);

    const result = await call('wait_for_resume', { task_id: 'T-1', timeout_seconds: 5 });
    expect(structured(result)).toMatchObject({
      task_id: 'T-1',
      status: 'READY',
      resumed: true,
      timed_out: false,
    });
  });

  it('wait_for_resume 超时未解挂：resumed=false / timed_out=true', async () => {
    await seedTask(h.prisma, 'T-1');
    const claimed = structured(await call('claim_next_task'))!;
    const lease = claimed.lease as { run_id: string; lease_id: string };
    await call('block_task', {
      task_id: 'T-1',
      run_id: lease.run_id,
      lease_id: lease.lease_id,
      block_id: 'h1',
      block_title: '仍待人工',
      instruction: '没人来处理',
    });

    const result = await call('wait_for_resume', { task_id: 'T-1', timeout_seconds: 1 });
    expect(structured(result)).toMatchObject({
      task_id: 'T-1',
      status: 'BLOCKED',
      resumed: false,
      timed_out: true,
    });
  });

  it('wait_for_resume 未知任务：TASK_GONE 而不是 500', async () => {
    const err = await call('wait_for_resume', { task_id: 'T-404', timeout_seconds: 2 });
    expect(err.isError).toBe(true);
    expect(structured(err)).toMatchObject({ code: 'TASK_GONE', task_id: 'T-404' });
  });

  // -------------------------------------------------- v0.0.4 W6 §16.1：技能三工具（list/get/search_skills）

  const skillCtx = () => ({
    claims: h.claims,
    leases: h.leases,
    writeback: h.writeback,
    query: h.query,
    skills: h.skills,
    policy: h.policy,
    breakdown: h.breakdown,
    creation: h.creation,
    settings: h.settings,
  });
  const ui: RequestAuth = { kind: 'ui' };

  /** 造技能：走 skillCreateSchema.parse 补全默认字段，origin 透传给服务层（W2 三来源）。 */
  async function seedSkill(
    input: Partial<SkillCreateInput> & { name?: string },
    origin?: SkillOrigin,
  ) {
    return h.skills.create(
      skillCreateSchema.parse({
        name: '测试技能',
        type: 'prompt',
        description: '',
        tags: [],
        mcp_dependencies: [],
        ...input,
      }),
      origin,
    );
  }

  it('list_skills 只回精简目录：不含正文/测试用例/MCP 依赖，体积不随正文增长', async () => {
    // 正文刻意写大：目录若把 content 一起带上，返回体积会跟着内容线性膨胀。
    await seedSkill({
      name: '代码审查',
      description: '四步审查',
      tags: ['质量'],
      content: { blocks: [{ id: 'b1', kind: 'prompt', title: '开场', prompt: 'x'.repeat(20_000) }], entryBlockId: 'b1' },
      mcp_dependencies: [{ server: 'github', tools: ['get_pull_request'], required: true }],
    });
    const result = await call('list_skills', {});
    const payload = structured(result)!;
    expect(result.isError).toBeUndefined();
    expect(payload.total).toBe(1);
    const [item] = payload.items as Record<string, unknown>[];
    expect(item).toMatchObject({
      name: '代码审查',
      skill_id: expect.stringMatching(/^skl_/),
      readonly: false,
    });
    // 正文三件套一律不出现在目录里（否则 124 条内置技能一次就是 1.0 MB）
    expect(item!.content).toBeUndefined();
    expect(item!.test_cases).toBeUndefined();
    expect(item!.mcp_dependencies).toBeUndefined();
    // 20 KB 的正文不该让目录长过 2 KB：这条是防「以后又把正文塞回来」的回归线。
    expect(JSON.stringify(payload).length).toBeLessThan(2_000);
    expect(await h.prisma.taskRun.count()).toBe(0);
  });

  it('list_skills 支持 limit/offset 翻页，total 是过滤后总数', async () => {
    for (const name of ['甲技能', '乙技能', '丙技能']) await seedSkill({ name });
    const first = structured(await call('list_skills', { limit: 2 }))!;
    expect(first).toMatchObject({ total: 3, returned: 2, limit: 2, offset: 0 });
    expect(String(first.next)).toContain('offset=2');

    const second = structured(await call('list_skills', { limit: 2, offset: 2 }))!;
    expect(second).toMatchObject({ total: 3, returned: 1, offset: 2 });
    expect(String(second.next)).toContain('列完');
  });

  it('list_skills 按 source 过滤命中三来源（W2 语义）', async () => {
    await seedSkill({ name: '默认巡检' }, 'default');
    await seedSkill({ name: '三方导入' }, 'imported');
    const filtered = structured(await call('list_skills', { source: 'imported' }))!;
    expect(filtered.total).toBe(1);
    expect((filtered.items as { name: string }[])[0]!.name).toBe('三方导入');
  });

  it('get_skill 命中返回详情（含版本历史与依赖），未知 id 回 NOT_FOUND', async () => {
    const created = await seedSkill({ name: '编排技能', type: 'workflow' });
    const ok = structured(await call('get_skill', { skill_id: created.id }))!;
    expect(ok).toMatchObject({ id: created.id, name: '编排技能' });
    expect(Array.isArray((ok as { versions: unknown[] }).versions)).toBe(true);

    const err = await call('get_skill', { skill_id: 'skl_missing' });
    expect(err.isError).toBe(true);
    expect(structured(err)!.code).toBe('NOT_FOUND');
  });

  it('search_skills keyword 必填：空/缺失被 VALIDATION_FAILED 挡下，命中 name/description', async () => {
    await seedSkill({ name: '数据库迁移', description: '执行 schema 变更' });
    const hit = structured(await call('search_skills', { keyword: '迁移' }))!;
    expect((hit as { total: number }).total).toBe(1);

    await expect(callAgentTool(skillCtx(), agent, 'search_skills', { keyword: '' })).rejects.toMatchObject({
      code: 'VALIDATION_FAILED',
    });
  });

  // ------------------- 技能发现面：用户说个大概 → 服务端给候选 → 用户挑（不让人回 UI 抄名字）

  it('search_skills 近义词也能命中：说「代码评审」时库里叫「代码审查」照样给候选', async () => {
    const created = await seedSkill({ name: '代码审查', description: '四步审查改动' });
    const hit = structured(await call('search_skills', { keyword: '代码评审' }))!;
    const items = hit.items as { skill_id: string; score: number; matched_on: string }[];
    // 子串口径下这里恒 0 命中（"代码评审" 不含于 "代码审查"），能命中全靠相似度兜底。
    expect(items[0]).toMatchObject({ skill_id: created.id, matched_on: 'similarity' });
    expect(items[0]!.score).toBeGreaterThan(0);
    expect(String(hit.next)).toContain('get_skill');
  });

  it('search_skills 分差 <15 时 ambiguous=true，next 要求交给用户选', async () => {
    await seedSkill({ name: '代码审查' });
    await seedSkill({ name: '代码审计' });
    const hit = structured(await call('search_skills', { keyword: '代码审' }))!;
    expect(hit.ambiguous).toBe(true);
    expect(String(hit.next)).toContain('让用户选');
    // 候选带 score/matched_on，agent 能向用户解释「为什么是这几条」
    expect(hit.items).toHaveLength(2);
    // 两条都是「名称前缀命中」= 80 分，分差 0 → 正是要靠 ambiguous 交给人选的情形
    expect((hit.items as { matched_on: string }[])[0]!.matched_on).toBe('name_prefix');
  });

  it('search_skills 名称全等命中时 ambiguous=false，next 直接给出 skill_id', async () => {
    const created = await seedSkill({ name: '数据库迁移' });
    await seedSkill({ name: '数据库迁移检查' });
    const hit = structured(await call('search_skills', { keyword: '数据库迁移' }))!;
    expect(hit.ambiguous).toBe(false);
    expect((hit.items as { skill_id: string }[])[0]!.skill_id).toBe(created.id);
    expect(String(hit.next)).toContain(created.id);
  });

  it('get_skill 支持按名称取正文：唯一命中直取、重名回 candidates、查无此名指向 search_skills', async () => {
    const created = await seedSkill({ name: '编排技能', type: 'workflow' });
    const byName = structured(await call('get_skill', { skill_name: '编排技能' }))!;
    expect(byName).toMatchObject({ id: created.id, name: '编排技能' });
    expect(Array.isArray((byName as { versions: unknown[] }).versions)).toBe(true);

    // 大小写不敏感：内置技能里有 ASCII 名（code-review 这类）
    const ascii = await seedSkill({ name: 'Code-Review' });
    expect(structured(await call('get_skill', { skill_name: 'code-review' }))).toMatchObject({
      id: ascii.id,
    });

    // 重名不替用户挑：回 candidates，让 agent 列给用户
    await seedSkill({ name: '重名技能' });
    await seedSkill({ name: '重名技能' });
    const dup = structured(await call('get_skill', { skill_name: '重名技能' }))!;
    expect(dup.ambiguous).toBe(true);
    expect((dup.candidates as unknown[]).length).toBe(2);

    const missing = await call('get_skill', { skill_name: '不存在的技能' });
    expect(missing.isError).toBe(true);
    expect(structured(missing)!.code).toBe('NOT_FOUND');
    expect(String(structured(missing)!.message)).toContain('search_skills');

    // id 与 name 必须且只能给一个：都没给 / 都给 一律 422
    for (const args of [{}, { skill_id: created.id, skill_name: '编排技能' }]) {
      await expect(callAgentTool(skillCtx(), agent, 'get_skill', args)).rejects.toMatchObject({
        code: 'VALIDATION_FAILED',
      });
    }
  });

  it('技能三工具拒绝 UI 会话 Token（agent 组专属，SKILL 读侧也守作用域）', async () => {
    for (const [name, args] of [
      ['list_skills', {}],
      ['get_skill', { skill_id: 'skl_x' }],
      ['search_skills', { keyword: 'q' }],
    ] as const) {
      await expect(callAgentTool(skillCtx(), ui, name, args)).rejects.toMatchObject({ code: 'FORBIDDEN' });
    }
  });

  // ------------------------------------------ §16.1 create_skill：补「技能面只能改、不能建」的缺口

  it('create_skill 落库与 UI 的 POST /skills 同口径：DRAFT + v0.1.0 + 初始版本快照 + source=custom', async () => {
    const created = structured(
      await call('create_skill', {
        name: 'Agent 建的技能',
        type: 'steps',
        description: '由 MCP 创建',
        category: '开发与实现',
        tags: ['自动化', '数据分析', '质量与安全'],
        // 只给最小块，验证 content 走的是同一份 skillContentSchema
        content: { blocks: [{ id: 'b1', kind: 'step', title: '第一步' }], entryBlockId: 'b1' },
        test_cases: [{ id: 'c1', name: '冒烟' }],
        mcp_dependencies: [{ server: 'github', tools: ['get_pull_request'] }],
      }),
    )!;

    expect(created).toMatchObject({
      name: 'Agent 建的技能',
      type: 'steps',
      status: 'DRAFT',
      current_version: 'v0.1.0',
      category: '开发与实现',
      source: 'custom',
      readonly: false,
    });
    // 0925 拍板二：写入侧同样过 freeTagsOf——叶子词「数据分析」被洗掉，
    // 六个产研阶段词是双角色特例（「质量与安全」既是分类叶子又是合法阶段标签）要保留。
    expect(created.tags).toEqual(['自动化', '质量与安全']);
    expect(created.content).toMatchObject({ entryBlockId: 'b1' });
    expect(created.mcp_dependencies).toEqual([
      { server: 'github', tools: ['get_pull_request'], required: true },
    ]);
    // 创建即写一条 v0.1.0 快照：发布/回滚从这条起步。
    const versions = await h.prisma.skillVersion.findMany({ where: { skillId: String(created.id) } });
    expect(versions).toHaveLength(1);
    expect(versions[0]).toMatchObject({ version: 'v0.1.0', changelog: '初始版本' });

    // 回到读工具能立刻查到（同一条落库路径，不是平行实现）。
    const fetched = structured(await call('get_skill', { skill_id: created.id }))!;
    expect(fetched.name).toBe('Agent 建的技能');
  });

  it('create_skill 只填必填项也能建（description/tags/content 等按 zod 默认值落空）', async () => {
    const created = structured(await call('create_skill', { name: '最简技能', type: 'prompt' }))!;
    expect(created).toMatchObject({
      description: '',
      category: '',
      tags: [],
      source: 'custom',
      status: 'DRAFT',
    });
    expect(created.content).toEqual({ blocks: [], entryBlockId: null });
  });

  it('create_skill 拒收 status / id / source（.strict 点名），type 词表外 422 并回显可接受值', async () => {
    // 发布要先由人走版本快照：只给 status 就会出现 current_version 与 content 脱节。
    await expect(
      callAgentTool(skillCtx(), agent, 'create_skill', { name: '越权', type: 'prompt', status: 'PUBLISHED' }),
    ).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
    await expect(
      callAgentTool(skillCtx(), agent, 'create_skill', { name: '越权', type: 'prompt', id: 'skl_x' }),
    ).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });

    // type 词表外：走 agent 入口的 422（B6 口径：details 里列出全部可接受值，不用回头翻文档）。
    const error = await callAgentTool(skillCtx(), agent, 'create_skill', {
      name: '类型错',
      type: 'not-a-type',
    }).catch((thrown: unknown) => thrown);
    expect(error).toMatchObject({ code: 'VALIDATION_FAILED' });
    expect(JSON.stringify(error)).toContain('workflow');
  });

  it('create_skill 拒绝 UI 会话 Token（与技能读工具同一条作用域守卫）', async () => {
    await expect(
      callAgentTool(skillCtx(), ui, 'create_skill', { name: 'x', type: 'prompt' }),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
  });

  // ---------------------------------------- v0.0.4 W6 §12.4/§12.6：check_mcp_policy / report_mcp_call

  async function auditRows(action: string) {
    return h.prisma.auditLog.findMany({ where: { action } });
  }

  it('check_mcp_policy 命中声明：allow + required 透传，并落一条策略决策审计', async () => {
    const skill = await seedSkill({
      mcp_dependencies: [{ server: 'github', tools: ['get_pull_request'], required: false }],
    });
    const result = structured(
      await call('check_mcp_policy', { skill_id: skill.id, server: 'github', tool: 'get_pull_request' }),
    )!;
    expect(result).toMatchObject({
      skill_id: skill.id,
      server: 'github',
      tool: 'get_pull_request',
      allowed: true,
      decision: 'allow',
      required: false,
    });
    const rows = await auditRows('mcp_policy_check');
    expect(rows).toHaveLength(1);
    expect(JSON.parse(rows[0]!.after!)).toMatchObject({ skill_id: skill.id, allowed: true });
    expect([rows[0]!.actorType, rows[0]!.targetType]).toEqual(['agent', 'mcp']);
  });

  it('check_mcp_policy 未声明服务器：deny（deny_undeclared），同样留决策审计', async () => {
    const skill = await seedSkill({
      mcp_dependencies: [{ server: 'github', tools: ['get_pull_request'], required: true }],
    });
    const result = structured(
      await call('check_mcp_policy', { skill_id: skill.id, server: 'gitlab', tool: 'get_merge_request' }),
    )!;
    expect(result).toMatchObject({ allowed: false, decision: 'deny', required: true });
    expect(String(result.reason)).toContain('deny_undeclared');
    expect((await auditRows('mcp_policy_check'))[0]!.after).toContain('deny');
  });

  it('check_mcp_policy 服务器命中但工具越界：deny（工具级精确声明，§12.2）', async () => {
    const skill = await seedSkill({
      mcp_dependencies: [{ server: 'github', tools: ['get_pull_request'], required: true }],
    });
    const result = structured(
      await call('check_mcp_policy', { skill_id: skill.id, server: 'github', tool: 'delete_repository' }),
    )!;
    expect(result).toMatchObject({ allowed: false, decision: 'deny' });
    expect(String(result.reason)).toContain('工具级');
  });

  it('check_mcp_policy 技能不存在回 NOT_FOUND；缺参回 VALIDATION_FAILED；UI Token 回 FORBIDDEN', async () => {
    const missing = await call('check_mcp_policy', { skill_id: 'skl_absent', server: 'github', tool: 'x' });
    expect(missing.isError).toBe(true);
    expect(structured(missing)!.code).toBe('NOT_FOUND');

    await expect(
      callAgentTool(skillCtx(), agent, 'check_mcp_policy', { skill_id: 'skl_a', server: 'github' }),
    ).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });

    await expect(
      callAgentTool(skillCtx(), ui, 'check_mcp_policy', { skill_id: 'skl_a', server: 'github', tool: 'x' }),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
  });

  it('report_mcp_call 成功/失败结果都落 mcp_call 审计，policy_decision 默认 unchecked', async () => {
    const skill = await seedSkill({});
    const ok = structured(
      await call('report_mcp_call', {
        skill_id: skill.id,
        server: 'github',
        url: 'https://api.githubcopilot.com/mcp/',
        tool: 'get_pull_request',
        success: true,
        duration_ms: 240,
        policy_decision: 'allow',
      }),
    )!;
    expect(ok).toEqual({ recorded: true });

    await call('report_mcp_call', {
      skill_id: skill.id,
      server: 'github',
      tool: 'create_review',
      success: false,
      error: 'upstream 500',
    });

    const rows = await auditRows('mcp_call');
    expect(rows).toHaveLength(2);
    const first = JSON.parse(rows.find((row) => row.after!.includes('240'))!.after!);
    expect(first).toMatchObject({ skill_id: skill.id, success: true, duration_ms: 240, policy_decision: 'allow' });
    const second = JSON.parse(rows.find((row) => !row.after!.includes('240'))!.after!);
    expect(second).toMatchObject({ success: false, error: 'upstream 500', policy_decision: 'unchecked' });
  });

  it('report_mcp_call 入参校验（success 必填、server 必填）与 UI Token 越界拒绝', async () => {
    await expect(
      callAgentTool(skillCtx(), agent, 'report_mcp_call', { server: 'github', tool: 'x' }),
    ).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
    await expect(
      callAgentTool(skillCtx(), agent, 'report_mcp_call', { tool: 'x', success: true }),
    ).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
    await expect(
      callAgentTool(skillCtx(), ui, 'report_mcp_call', { server: 'github', tool: 'x', success: true }),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect(await auditRows('mcp_call')).toHaveLength(0);
  });
});
