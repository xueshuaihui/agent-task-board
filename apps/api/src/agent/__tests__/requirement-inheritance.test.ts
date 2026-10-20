import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { RequestAuth } from '../../auth/auth.scope';
import { skillCreateSchema, type SkillCreateInput, type SkillDto } from '../../skills/skills.dto';
import { claimSchema, listReadyQuerySchema } from '../agent-inputs';
import {
  buildRulesSnapshot,
  digestRulesSnapshot,
  type RulesSnapshot,
} from '../requirement-context';
import { createAgentHarness, seedTask, type AgentHarness } from './temp-db';

/**
 * #8 需求级执行规则与技能继承（Agent 载荷 + 领取快照）。
 *
 * 覆盖三件事：
 * 1. 载荷口径：`requirement` 只认 `type='需求'` 的父任务；`effective_skills` 按「需求优先」
 *    合并且带 `source`；旧字段 `skills` 仍只含任务自身绑定（旧客户端不受影响）。
 * 2. 快照口径：claim 把规则/技能冻结进 `task_runs.rules_snapshot` + `rules_digest`，
 *    digest 与回执 `rules_digest` 同值，且不随 captured_at 改变。
 * 3. 时效口径：运行中改需求规则不影响已存在的 Run，新领取用最新规则且 digest 随之变化。
 */
let h: AgentHarness;
let agent: RequestAuth;

const claimInput = claimSchema.parse({});
const listInput = listReadyQuerySchema.parse({});

const OLD_RULES = '执行前先备份数据库，禁止修改生产配置';
const NEW_RULES = '先跑迁移检查脚本，失败即停';

beforeAll(async () => {
  h = createAgentHarness();
  agent = await h.agent('agent-requirement');
});

afterAll(async () => {
  await h.dispose();
});

beforeEach(async () => {
  await h.prisma.taskRun.deleteMany();
  await h.prisma.taskDependency.deleteMany();
  await h.prisma.auditLog.deleteMany();
  await h.prisma.comment.deleteMany();
  // 父需求被孩子外键引用，先删子任务再清全表。
  await h.prisma.task.deleteMany({ where: { parentTaskId: { not: null } } });
  await h.prisma.task.deleteMany();
  await h.prisma.skillVersion.deleteMany();
  await h.prisma.skill.deleteMany();
  await h.prisma.$executeRawUnsafe(`UPDATE id_sequences SET next = 0 WHERE name = 'run'`);
  h.emitted.length = 0;
});

/** 造技能：走 skillCreateSchema.parse 补全默认字段（与 MCP 技能用例同口径）。 */
async function seedSkill(input: Partial<SkillCreateInput> & { name: string }): Promise<SkillDto> {
  return h.skills.create(
    skillCreateSchema.parse({
      type: 'prompt',
      description: '',
      tags: [],
      mcp_dependencies: [],
      ...input,
    }),
  );
}

/**
 * 一个需求 + 若干子任务的夹具：
 * - 技能 A 先建 v0.1.0（任务版内容），再发 v0.1.1（需求版内容）；
 * - 需求绑 A@v0.1.1，子任务绑 A@v0.1.0 + B，专门测「同 id 需求版本优先」；
 * - 规则默认 OLD_RULES，updated_at 存 SQL 文本，验证出参 ISO 化。
 */
async function seedRequirementWithChildren(options: {
  rules?: string | null;
  rulesUpdatedAt?: string | null;
  childIds?: string[];
} = {}) {
  const skillA = await seedSkill({
    name: '技能 A',
    content: {
      blocks: [{ id: 'b-task', kind: 'prompt', title: '任务版', prompt: '任务版内容' }],
      entryBlockId: 'b-task',
    },
  });
  const skillB = await seedSkill({ name: '技能 B' });
  const updatedA = await h.skills.createVersion(skillA.id, {
    content: {
      blocks: [{ id: 'b-req', kind: 'prompt', title: '需求版', prompt: '需求版内容' }],
      entryBlockId: 'b-req',
    },
    changelog: '需求版',
  });
  expect(updatedA.current_version).not.toBe(skillA.current_version);

  await seedTask(h.prisma, 'REQ-1', {
    type: '需求',
    status: 'BACKLOG',
    title: '登录改造需求',
    skills: JSON.stringify([{ skill_id: skillA.id, version: updatedA.current_version }]),
    executionRules: options.rules === undefined ? OLD_RULES : options.rules,
    executionRulesUpdatedAt:
      options.rulesUpdatedAt === undefined ? '2026-10-01 08:00:00' : options.rulesUpdatedAt,
  });
  const childIds = options.childIds ?? ['T-child-1'];
  for (const [index, id] of childIds.entries()) {
    await seedTask(h.prisma, id, {
      parentTaskId: 'REQ-1',
      title: `子任务 ${index + 1}`,
      skills: JSON.stringify([
        { skill_id: skillA.id, version: skillA.current_version },
        { skill_id: skillB.id, version: skillB.current_version },
      ]),
    });
  }
  return { skillA, skillB, updatedA, childIds };
}

describe('#8 需求载荷与技能继承', () => {
  it('领取需求子任务：requirement 带规则，effective_skills 需求版本优先，旧 skills 只含任务绑定', async () => {
    const { skillA, skillB, updatedA } = await seedRequirementWithChildren();

    const result = await h.claims.claim(claimInput, agent);
    expect(result.task?.id).toBe('T-child-1');
    const task = result.task!;

    expect(task.requirement).not.toBeNull();
    expect(task.requirement).toMatchObject({
      id: 'REQ-1',
      title: '登录改造需求',
      execution_rules: OLD_RULES,
      execution_rules_updated_at: '2026-10-01T08:00:00Z',
    });
    expect(task.requirement!.skills.map((skill) => skill.skill_id)).toEqual([skillA.id]);
    expect(task.requirement!.skills[0]!.version).toBe(updatedA.current_version);
    expect(JSON.stringify(task.requirement!.skills[0]!.content)).toContain('需求版内容');

    // 合并清单：需求 ref 在前且版本取需求侧，任务独有的 B 在后。
    expect(task.effective_skills.map((skill) => skill.skill_id)).toEqual([skillA.id, skillB.id]);
    const effectiveA = task.effective_skills[0]!;
    expect(effectiveA.source).toBe('requirement');
    expect(effectiveA.version).toBe(updatedA.current_version);
    expect(JSON.stringify(effectiveA.content)).toContain('需求版内容');
    const effectiveB = task.effective_skills[1]!;
    expect(effectiveB.source).toBe('task');
    expect(effectiveB.version).toBe(skillB.current_version);

    // 旧字段保持不变：只含任务自身绑定，A 仍是任务绑的 v0.1.0。
    expect(task.skills.map((skill) => skill.skill_id)).toEqual([skillA.id, skillB.id]);
    expect(task.skills[0]!.version).toBe(skillA.current_version);
    expect(JSON.stringify(task.skills[0]!.content)).toContain('任务版内容');
  });

  it('领取时把规则冻结进 task_runs：快照可解析、digest 为 64 位 hex 且与回执一致', async () => {
    const { skillA } = await seedRequirementWithChildren();

    const result = await h.claims.claim(claimInput, agent);
    expect(result.rules_digest).toMatch(/^[0-9a-f]{64}$/);

    const run = await h.prisma.taskRun.findUniqueOrThrow({ where: { id: result.lease!.run_id } });
    expect(run.rulesSnapshot).toBeTruthy();
    const snapshot = JSON.parse(run.rulesSnapshot!) as RulesSnapshot;
    expect(snapshot.requirement).toMatchObject({
      id: 'REQ-1',
      title: '登录改造需求',
      execution_rules: OLD_RULES,
      execution_rules_updated_at: '2026-10-01T08:00:00Z',
    });
    expect(snapshot.task_skills).toHaveLength(2);
    expect(snapshot.task_skills[0]!).toMatchObject({
      skill_id: skillA.id,
      version: skillA.current_version,
    });
    expect(snapshot.effective_skills.map((ref) => ref.source)).toEqual(['requirement', 'task']);
    expect(snapshot.captured_at).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);

    expect(run.rulesDigest).toMatch(/^[0-9a-f]{64}$/);
    // 同一快照重算 digest 必须一致；captured_at 不参与 digest。
    expect(digestRulesSnapshot(snapshot)).toBe(run.rulesDigest);
    expect(digestRulesSnapshot(buildRulesSnapshot(snapshot, '2030-01-01T00:00:00.000Z'))).toBe(
      run.rulesDigest,
    );
    expect(result.rules_digest).toBe(run.rulesDigest);
  });

  it('规则改动后：get_task 给新值，旧 Run 快照不变，新领取用新规则且 digest 变化', async () => {
    await seedRequirementWithChildren({ childIds: ['T-child-1', 'T-child-2'] });

    const first = await h.claims.claim(claimInput, agent);
    expect(first.task?.id).toBe('T-child-1');
    const oldRun = await h.prisma.taskRun.findUniqueOrThrow({ where: { id: first.lease!.run_id } });
    const oldDigest = oldRun.rulesDigest;

    await h.prisma.task.update({
      where: { id: 'REQ-1' },
      data: { executionRules: NEW_RULES, executionRulesUpdatedAt: '2026-10-02 09:30:00' },
    });

    // 当前值：get_task（payload）读到新规则。
    const detail = await h.query.payload('T-child-1');
    expect(detail.requirement!.execution_rules).toBe(NEW_RULES);
    expect(detail.requirement!.execution_rules_updated_at).toBe('2026-10-02T09:30:00Z');

    // 旧 Run 的快照与 digest 不随需求改动。
    const oldAfter = await h.prisma.taskRun.findUniqueOrThrow({ where: { id: first.lease!.run_id } });
    expect(oldAfter.rulesDigest).toBe(oldDigest);
    expect((JSON.parse(oldAfter.rulesSnapshot!) as RulesSnapshot).requirement!.execution_rules).toBe(
      OLD_RULES,
    );

    // 新领取：另一个子任务拿到新规则，digest 与旧 Run 不同。
    const second = await h.claims.claim(claimInput, agent);
    expect(second.task?.id).toBe('T-child-2');
    const newRun = await h.prisma.taskRun.findUniqueOrThrow({ where: { id: second.lease!.run_id } });
    const newSnapshot = JSON.parse(newRun.rulesSnapshot!) as RulesSnapshot;
    expect(newSnapshot.requirement!.execution_rules).toBe(NEW_RULES);
    expect(newSnapshot.requirement!.execution_rules_updated_at).toBe('2026-10-02T09:30:00Z');
    expect(newRun.rulesDigest).not.toBe(oldDigest);
    expect(digestRulesSnapshot(newSnapshot)).toBe(newRun.rulesDigest);
    expect(second.rules_digest).toBe(newRun.rulesDigest);
  });

  it('无父需求：requirement=null，effective_skills 全为 source=task，旧 skills 不变', async () => {
    const skill = await seedSkill({ name: '独立技能' });
    await seedTask(h.prisma, 'T-solo', {
      skills: JSON.stringify([{ skill_id: skill.id, version: skill.current_version }]),
    });

    const result = await h.claims.claim(claimInput, agent);
    const task = result.task!;
    expect(task.requirement).toBeNull();
    expect(task.effective_skills).toHaveLength(1);
    expect(task.effective_skills[0]).toMatchObject({
      skill_id: skill.id,
      version: skill.current_version,
      source: 'task',
    });
    expect(task.skills).toHaveLength(1);
    expect(task.skills[0]!.skill_id).toBe(skill.id);

    // 快照同样记录「无需求」，任务技能仍被冻结。
    const run = await h.prisma.taskRun.findUniqueOrThrow({ where: { id: result.lease!.run_id } });
    const snapshot = JSON.parse(run.rulesSnapshot!) as RulesSnapshot;
    expect(snapshot.requirement).toBeNull();
    expect(snapshot.effective_skills).toEqual([
      { skill_id: skill.id, version: skill.current_version, source: 'task' },
    ]);
  });

  it('list_ready_tasks 摘要带 requirement_id/title/has_execution_rules，无需求为 null/false', async () => {
    const { skillA, skillB } = await seedRequirementWithChildren();
    await seedTask(h.prisma, 'T-solo');

    const listed = await h.claims.listReady(listInput, agent);
    const withRequirement = listed.items.find((item) => item.id === 'T-child-1')!;
    expect(withRequirement.requirement_id).toBe('REQ-1');
    expect(withRequirement.requirement_title).toBe('登录改造需求');
    expect(withRequirement.has_execution_rules).toBe(true);
    expect(withRequirement.effective_skill_ids).toEqual([skillA.id, skillB.id]);

    const withoutRequirement = listed.items.find((item) => item.id === 'T-solo')!;
    expect(withoutRequirement.requirement_id).toBeNull();
    expect(withoutRequirement.requirement_title).toBeNull();
    expect(withoutRequirement.has_execution_rules).toBe(false);
  });

  it('execution_rules 为空串/空白时归一为 null，摘要 has_execution_rules=false', async () => {
    await seedRequirementWithChildren({
      rules: '  \n\t ',
      rulesUpdatedAt: null,
      childIds: ['T-child-1'],
    });

    const payload = await h.query.payload('T-child-1');
    expect(payload.requirement).not.toBeNull();
    expect(payload.requirement!.execution_rules).toBeNull();
    expect(payload.requirement!.execution_rules_updated_at).toBeNull();

    const listed = await h.claims.listReady(listInput, agent);
    expect(listed.items.find((item) => item.id === 'T-child-1')!.has_execution_rules).toBe(false);
  });
});
