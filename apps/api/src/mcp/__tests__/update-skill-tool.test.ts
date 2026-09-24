import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { RequestAuth } from '../../auth/auth.scope';
import { createAgentMcpServer, callAgentTool, type AgentToolContext } from '../../mcp/mcp.server';
import { ZodPipe } from '../../infra/zod.pipe';
import { SKILL_CATEGORIES } from '../../skills/skill-categories';
import {
  skillCreateSchema,
  skillPatchSchema,
  type SkillContent,
  type SkillCreateInput,
  type SkillOrigin,
} from '../../skills/skills.dto';
import { createAgentHarness, type AgentHarness } from '../../agent/__tests__/temp-db';

/**
 * §16.1 `update_skill`（Agent 面技能全字段 PATCH）的回归。
 *
 * 走真实 Client ↔ Server 内存传输的 `tools/call` 全链路（同 update-task-tool.test.ts 的口径），
 * 外加一条 `callAgentTool` 的直连通道：字段校验与三条守卫（默认技能只读 / 子技能自引用 /
 * 引用成环）全在 `SkillsService.patch` 那一份里，把它 mock 掉就等于什么都没测。
 * REST 侧的既有用例已经锁过那套字段规则，这里锁的是：
 * 「谁能改、改得到哪些字段、改不到什么、被拒时两条通道各回什么」。
 */
let h: AgentHarness;
let agent: RequestAuth;
const ui: RequestAuth = { kind: 'ui' };
let client: Client;
/** 同一个 ctx：既拿来建 server（通道一），也直接 callAgentTool（通道二，绕过 SDK 的参数剥离）。 */
let toolCtx: AgentToolContext;

interface ToolResult {
  content: { type: string; text: string }[];
  structuredContent?: Record<string, unknown>;
  isError?: boolean;
}

async function call(name: string, args: Record<string, unknown> = {}): Promise<ToolResult> {
  return (await client.callTool({ name, arguments: args })) as unknown as ToolResult;
}

function structured(result: ToolResult) {
  return result.structuredContent!;
}

/** 造技能：走 skillCreateSchema.parse 补全默认字段，origin 透传给服务层（W2 三来源）。 */
async function seedSkill(
  input: Partial<SkillCreateInput> & { name?: string },
  origin: SkillOrigin = 'custom',
) {
  return h.skills.create(
    skillCreateSchema.parse({ name: '测试技能', type: 'prompt', tags: [], mcp_dependencies: [], ...input }),
    origin,
  );
}

/** 只有一个 prompt 块的最小 content：整体覆盖的用例都从它出发。 */
function contentWith(text: string): SkillContent {
  return { blocks: [{ id: 'b1', kind: 'prompt', title: '', text }], entryBlockId: 'b1' };
}

/** `skillCreateSchema` 的缺省 content（seedSkill 不给 content 时落库的就是它）：守卫拒改后应与它逐字相同。 */
const EMPTY_CONTENT = JSON.stringify({ blocks: [], entryBlockId: null });

/** 引用目标技能的一个 subskill 块（skillRef 就是块上的引用字段，检测在 skill-reference.ts）。 */
function contentReferencing(skillId: string): SkillContent {
  return { blocks: [{ id: 's1', kind: 'subskill', title: '', skillRef: skillId }], entryBlockId: 's1' };
}

beforeAll(async () => {
  h = createAgentHarness();
  agent = await h.agent('update-skill-client', []);
  toolCtx = {
    claims: h.claims,
    leases: h.leases,
    writeback: h.writeback,
    query: h.query,
    skills: h.skills,
    policy: h.policy,
    breakdown: h.breakdown,
    creation: h.creation,
    settings: h.settings,
  };
  const server = createAgentMcpServer(agent, toolCtx);
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  await server.connect(serverSide);
  client = new Client({ name: 'update-skill-test', version: '0.0.0' });
  await client.connect(clientSide);
});

afterAll(async () => {
  await client?.close().catch(() => undefined);
  await h?.dispose();
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

describe('update_skill 写面：自定义/三方技能的业务字段', () => {
  it('改 name/category/tags 成功，返回体与库里都是新值；未提交的 description 原样', async () => {
    const skill = await seedSkill({ name: '旧名', description: '原始描述', category: '推荐' });

    const result = await call('update_skill', {
      skill_id: skill.id,
      name: 'Agent 改过的名',
      category: '开发编程',
      tags: ['重构', 'P1'],
    });

    expect(result.isError).toBeUndefined();
    const payload = structured(result);
    // 返回体就是新的技能详情（SkillsService.detail 同源），agent 不用再查一次 get_skill。
    expect([payload.name, payload.category, payload.tags, payload.description]).toEqual([
      'Agent 改过的名',
      '开发编程',
      ['重构', 'P1'],
      '原始描述',
    ]);
    const stored = await h.prisma.skill.findUniqueOrThrow({ where: { id: skill.id } });
    expect([stored.name, stored.category, stored.tags]).toEqual([
      'Agent 改过的名',
      '开发编程',
      JSON.stringify(['重构', 'P1']),
    ]);
  });

  it('category 传空串=显式改未分类（与 UI 的两态语义同一份 zod），不传=不改', async () => {
    const skill = await seedSkill({ category: '教育学习' });

    const cleared = structured(await call('update_skill', { skill_id: skill.id, name: '顺手改名' }));
    expect(cleared.category).toBe('教育学习');

    const uncategorized = structured(await call('update_skill', { skill_id: skill.id, category: '' }));
    expect(uncategorized.category).toBe('');
    expect((await h.prisma.skill.findUniqueOrThrow({ where: { id: skill.id } })).category).toBe('');
  });

  it('content 是整体覆盖：只提交一个新块就把旧块清掉，改后 get_skill 拿到的就是新的一份', async () => {
    const skill = await h.skills.create(
      skillCreateSchema.parse({
        name: '多块技能',
        type: 'workflow',
        content: {
          blocks: [
            { id: 'a1', kind: 'prompt', title: '留着' },
            { id: 'a2', kind: 'comment', title: '', note: '旧注释块' },
          ],
          entryBlockId: 'a1',
        },
        tags: [],
        mcp_dependencies: [],
      }),
      'custom',
    );

    const payload = structured(
      await call('update_skill', { skill_id: skill.id, content: contentWith('整份重写') }),
    );
    expect(payload.content).toEqual(contentWith('整份重写'));
    const viaGet = structured(await call('get_skill', { skill_id: skill.id }));
    expect((viaGet.content as SkillContent).blocks).toHaveLength(1);
    // 草稿覆盖不等于发布：current_version 仍停在创建时的 v0.1.0（版本快照只在 UI 走）。
    expect(payload.current_version).toBe('v0.1.0');
  });

  it('test_cases 同样整体覆盖（≤50 条，元素 {id,name,input?,expected?}）', async () => {
    const skill = await seedSkill({
      test_cases: [{ id: 'c1', name: '旧用例' }, { id: 'c2', name: '还要旧的' }],
    });

    const payload = structured(
      await call('update_skill', {
        skill_id: skill.id,
        test_cases: [{ id: 'n1', name: '新用例', input: 'x', expected: 'y' }],
      }),
    );
    expect(payload.test_cases).toEqual([{ id: 'n1', name: '新用例', input: 'x', expected: 'y' }]);
  });

  it('Agent 凭证专属：UI 会话 Token 走本工具回 FORBIDDEN（与 list_skills 同口径）', async () => {
    const skill = await seedSkill({ name: '鉴权用例' });
    await expect(
      callAgentTool(toolCtx, ui, 'update_skill', { skill_id: skill.id, name: 'UI 面不走这里' }),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect((await h.prisma.skill.findUniqueOrThrow({ where: { id: skill.id } })).name).toBe('鉴权用例');
  });
});

describe('update_skill 复用 SkillsService 的三条守卫（一条都不放宽）', () => {
  it('内置默认技能（source=default）→ SKILL_READONLY，错误里带 skill_id，字段一字未改', async () => {
    const builtin = await seedSkill({ name: '内置默认技能' }, 'default');

    const result = await call('update_skill', { skill_id: builtin.id, name: '想改内置' });

    expect(result.isError).toBe(true);
    const payload = structured(result);
    expect(payload.code).toBe('SKILL_READONLY');
    expect(payload.skill_id).toBe(builtin.id);
    expect((payload.message as string)).toContain('内置默认技能');
    expect((await h.prisma.skill.findUniqueOrThrow({ where: { id: builtin.id } })).name).toBe(
      '内置默认技能',
    );
    // 双通道同源（B6 口径）：只解析 content[0] 的客户端也拿到同一份错误体。
    expect(JSON.parse(result.content[0]!.text).error).toMatchObject({ code: 'SKILL_READONLY' });
  });

  it('content 里的 subskill 块引用自身 → SKILL_REF_SELF', async () => {
    const skill = await seedSkill({ name: '自引用' });

    const result = await call('update_skill', {
      skill_id: skill.id,
      content: contentReferencing(skill.id),
    });

    expect(result.isError).toBe(true);
    expect(structured(result).code).toBe('SKILL_REF_SELF');
    expect(structured(result).skill_id).toBe(skill.id);
    // 守卫在落库前：content 保持创建时的缺省值（seedSkill 未给 content）
    expect((await h.prisma.skill.findUniqueOrThrow({ where: { id: skill.id } })).content).toBe(
      EMPTY_CONTENT,
    );
  });

  it('经另一个技能回到自己 → SKILL_REF_CYCLE，回显 chain 环路径', async () => {
    const a = await seedSkill({ name: 'A' });
    const b = await seedSkill({ name: 'B' });
    // 先造出 B→A（合法：此时 A 不出边）
    await call('update_skill', { skill_id: b.id, content: contentReferencing(a.id) });

    // 再把 A 改成 A→B，成环 A→B→A
    const result = await call('update_skill', {
      skill_id: a.id,
      content: contentReferencing(b.id),
    });

    expect(result.isError).toBe(true);
    const payload = structured(result);
    expect(payload.code).toBe('SKILL_REF_CYCLE');
    expect(payload.chain).toEqual([a.id, b.id, a.id]);
    expect(payload.message).toContain('→');
    // A 的内容没被写进去：成环的这份草稿整份作废
    expect((await h.prisma.skill.findUniqueOrThrow({ where: { id: a.id } })).content).toBe(
      EMPTY_CONTENT,
    );
  });
});

describe('update_skill 的 category 词表回显（B6 口径补在 agent 入口这一层）', () => {
  it('通道二（callAgentTool 直连）→ 422：details 带全量 11 词表 + 当前收到的值 + 字段描述', async () => {
    const skill = await seedSkill({ name: '词表用例', category: '推荐' });

    await expect(
      callAgentTool(toolCtx, agent, 'update_skill', { skill_id: skill.id, category: '不存在的分类' }),
    ).rejects.toMatchObject({
      code: 'VALIDATION_FAILED',
      message: expect.stringContaining('可选：'),
    });

    let caught: { details?: Record<string, unknown>[] } | undefined;
    try {
      await callAgentTool(toolCtx, agent, 'update_skill', { skill_id: skill.id, category: '不存在的分类' });
    } catch (error) {
      caught = error as { details?: Record<string, unknown>[] };
    }
    const [detail] = caught!.details!;
    expect(detail).toMatchObject({ path: 'category', code: 'invalid_value', received: '不存在的分类' });
    // 一次改对：11 个词全在回显里，agent 不必试错。
    const hint = `${detail!.message} ${detail!.hint}`;
    for (const category of SKILL_CATEGORIES) {
      expect(hint).toContain(category);
    }
    expect(SKILL_CATEGORIES).toHaveLength(11);
    // 未分类的空串也是合法值，回显里要点明。
    expect(detail!.hint).toContain("''");
    expect((await h.prisma.skill.findUniqueOrThrow({ where: { id: skill.id } })).category).toBe('推荐');
  });

  // 0925 拍板（第四片）：「开学季」已从词表删除，如今是**越表值**——agent 直传同样 422、
  // 列值不动，且全量回显里不再出现该词（词表收敛必须能从这里被 agent 看见）。
  it('「开学季」现为越表值：422 VALIDATION_FAILED，回显词表不含它，列值不动', async () => {
    const skill = await seedSkill({ name: '越表靶子', category: '开发编程' });

    let caught: { details?: Record<string, unknown>[] } | undefined;
    await expect(
      callAgentTool(toolCtx, agent, 'update_skill', { skill_id: skill.id, category: '开学季' }),
    ).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
    try {
      await callAgentTool(toolCtx, agent, 'update_skill', { skill_id: skill.id, category: '开学季' });
    } catch (error) {
      caught = error as { details?: Record<string, unknown>[] };
    }
    const [detail] = caught!.details!;
    expect(detail).toMatchObject({ path: 'category', code: 'invalid_value', received: '开学季' });
    // hint = 「可接受值：<11 词全量枚举>；当前收到 "开学季"；<字段描述含可选：…全量词表>」——
    // 该词只允许以「当前收到」的回显出现，两处词表枚举段都不许再含它。
    const hint = String(detail!.hint);
    expect(hint.split('；当前收到')[0]!).not.toContain('开学季');
    expect(hint.split('可选：')[1]!).not.toContain('开学季');
    expect((await h.prisma.skill.findUniqueOrThrow({ where: { id: skill.id } })).category).toBe('开发编程');
  });

  it('通道一（SDK tools/call）→ SDK 自己的 enum 检查先拦（isError + 纯文本、无 structuredContent），词表原文照出', async () => {
    const skill = await seedSkill({ name: 'SDK 通道词表' });

    const result = await call('update_skill', { skill_id: skill.id, category: '不存在的分类' });

    expect(result.isError).toBe(true);
    // 如实记录通道差异：这一层是 MCP 协议层的入参校验（-32602），不是我们的 13 章错误体。
    expect(result.structuredContent).toBeUndefined();
    const text = result.content[0]!.text;
    expect(text).toContain('Input validation error');
    expect(text).toContain('category');
    for (const category of SKILL_CATEGORIES) {
      expect(text).toContain(category);
    }
  });

  it('REST 面的报错形状没被动：ZodPipe 仍只出裸 zod 的 {path,code,message} 三键', () => {
    let caught: { details?: Record<string, unknown>[] } | undefined;
    try {
      new ZodPipe(skillPatchSchema).transform({ category: '不存在的分类' }, { type: 'body' });
    } catch (error) {
      caught = error as { details?: Record<string, unknown>[] };
    }
    const [detail] = caught!.details!;
    expect(Object.keys(detail!).sort()).toEqual(['code', 'message', 'path']);
    expect(detail!.path).toBe('category');
    expect(detail!.code).toBe('invalid_value');
    // 就是改动前那条裸 zod 文案（UI 的控件回填在用，一字不改）。
    expect(detail!.message).toContain('Invalid option');
    // agent 侧新加的 received/hint 一个都不许漏进 UI 的那份。
    expect(JSON.stringify(caught!.details)).not.toContain('received');
    expect(JSON.stringify(caught!.details)).not.toContain('hint');
  });
});

describe('update_skill 的空 PATCH 与越权面（status / mcp_dependencies 都不在可写名单里）', () => {
  it('一个可写字段都没给 → 拒，且不动 updatedAt', async () => {
    const skill = await seedSkill({ name: '空改' });
    const before = await h.prisma.skill.findUniqueOrThrow({ where: { id: skill.id } });

    const result = await call('update_skill', { skill_id: skill.id });

    expect(result.isError).toBe(true);
    expect(structured(result).code).toBe('VALIDATION_FAILED');
    expect(structured(result).message).toContain('没有需要更新的字段');
    const after = await h.prisma.skill.findUniqueOrThrow({ where: { id: skill.id } });
    expect([after.name, after.updatedAt]).toEqual([before.name, before.updatedAt]);
  });

  it('未知 id → NOT_FOUND（守卫顺序与 REST 一致：先查存在性再谈只读）', async () => {
    const result = await call('update_skill', { skill_id: 'skl_missing', name: '不存在也要有骨气' });
    expect(structured(result).code).toBe('NOT_FOUND');
  });

  it('status 写不进来：通道一被协议层剥掉（只带它则 refine 报空 PATCH），通道二由 .strict() 点名拒', async () => {
    const skill = await seedSkill({ name: '想发布' }); // create 出来的就是 DRAFT

    // 只带 status：SDK 按 inputSchema 剥掉未声明键 → 剥完就空了，命中「至少一个可写字段」。
    const only = await call('update_skill', { skill_id: skill.id, status: 'PUBLISHED' });
    expect(only.isError).toBe(true);
    expect(structured(only).code).toBe('VALIDATION_FAILED');
    expect(structured(only).message).toContain('没有需要更新的字段');

    // 夹带在合法改动里：status 被剥掉、name 照常改，状态仍是 DRAFT——
    // 发布要的是「版本快照 + 置为已发布」两步（UI 走 POST /skills/:id/versions），agent 面没有快照工具。
    const mixed = await call('update_skill', {
      skill_id: skill.id,
      name: '改了名但没发布',
      status: 'PUBLISHED',
    });
    expect(mixed.isError).toBeUndefined();
    expect([structured(mixed).name, structured(mixed).status]).toEqual(['改了名但没发布', 'DRAFT']);

    // 通道二没有 SDK 那层剥离：由 updateSkillSchema 的 .strict() 硬拒并点名未知字段。
    await expect(
      callAgentTool(toolCtx, agent, 'update_skill', {
        skill_id: skill.id,
        name: '顺手发布',
        status: 'PUBLISHED',
      }),
    ).rejects.toMatchObject({
      code: 'VALIDATION_FAILED',
      message: expect.stringContaining('status'),
    });
    expect((await h.prisma.skill.findUniqueOrThrow({ where: { id: skill.id } })).status).toBe('DRAFT');
  });

  it('mcp_dependencies 同样写不进（与 UI 的 PATCH 面一致：它只在创建与版本创建里出现）', async () => {
    const skill = await seedSkill({
      name: '带依赖',
      mcp_dependencies: [{ server: 'github', tools: ['get_pull_request'], required: true }],
    });

    const only = await call('update_skill', {
      skill_id: skill.id,
      mcp_dependencies: [{ server: 'evil', tools: ['shell'], required: false }],
    });
    expect(structured(only).message).toContain('没有需要更新的字段');

    await expect(
      callAgentTool(toolCtx, agent, 'update_skill', {
        skill_id: skill.id,
        name: '夹带越权依赖',
        mcp_dependencies: [{ server: 'evil', tools: ['shell'], required: false }],
      }),
    ).rejects.toMatchObject({
      code: 'VALIDATION_FAILED',
      message: expect.stringContaining('mcp_dependencies'),
    });

    const stored = await h.prisma.skill.findUniqueOrThrow({ where: { id: skill.id } });
    expect(stored.mcpDependencies).toBe(JSON.stringify(skill.mcp_dependencies));
    expect(stored.name).toBe('带依赖');
  });

  it('REST 入口的行为未变：SkillsService.patch 仍能改 status（UI 的发布第二步不走 agent 面，也没被削弱）', async () => {
    const skill = await seedSkill({ name: 'UI 发布链路' });
    const patched = await h.skills.patch(skill.id, { status: 'PUBLISHED' });
    expect(patched.status).toBe('PUBLISHED');
    // 且 REST 那份越权面也还是原样：skillPatchSchema 里没有 mcp_dependencies。
    expect(Object.keys(skillPatchSchema.shape).sort()).toEqual(
      ['category', 'content', 'description', 'name', 'status', 'tags', 'test_cases'],
    );
  });
});
