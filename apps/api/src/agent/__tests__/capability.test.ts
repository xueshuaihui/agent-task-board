import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { claimSchema, listReadyQuerySchema } from '../agent-inputs';
import {
  capabilitiesCovered,
  effectiveCapabilities,
  taskTypeAllowed,
} from '../capability-match';
import type { RequestAuth } from '../../auth/auth.scope';
import { createAgentHarness, seedTask, type AgentHarness } from './temp-db';

/**
 * 20.5 的能力匹配。契约上最容易出错的方向是「领不到但看得见」——
 * Agent 会反复重试一个永远拿不到的任务，所以 list 与 claim 必须共用同一个判定，
 * 这里既测纯函数也测两个入口的实际可见性。
 */
let h: AgentHarness;
let tokenGo: RequestAuth;
let tokenJava: RequestAuth;

beforeAll(async () => {
  h = createAgentHarness();
  tokenGo = await h.agent('agent-go', ['language:go']);
  tokenJava = await h.agent('agent-java', ['language:java', 'tool:maven']);
});

afterAll(async () => {
  await h.dispose();
});

beforeEach(async () => {
  await h.prisma.auditLog.deleteMany();
  await h.prisma.comment.deleteMany();
  await h.prisma.taskRun.deleteMany();
  await h.prisma.task.deleteMany();
});

describe('子集判定纯函数', () => {
  it('required ⊆ effective 才通过；required 为空对任何 Token 可见', () => {
    const effective = new Set(['language:java']);
    expect(capabilitiesCovered([], effective)).toBe(true);
    expect(capabilitiesCovered(['language:java'], effective)).toBe(true);
    expect(capabilitiesCovered(['language:java', 'tool:maven'], effective)).toBe(false);
  });

  it('入参 capabilities 非空时覆盖 Token 声明，为空则回落（20.5 第一步）', () => {
    expect(effectiveCapabilities(['tool:git'], ['language:go'])).toEqual(['tool:git']);
    expect(effectiveCapabilities([], ['language:go'])).toEqual(['language:go']);
    expect(effectiveCapabilities(undefined, ['language:go'])).toEqual(['language:go']);
  });

  it('task_types 为空表示不限', () => {
    expect(taskTypeAllowed('需求', [])).toBe(true);
    expect(taskTypeAllowed('需求', ['缺陷'])).toBe(false);
  });
});

describe('认领与列表的可见性（验收 40）', () => {
  const CLAIM = claimSchema.parse({});

  it('required=["language:java"]：只声明 language:go 的 Token 领不到也看不见', async () => {
    await seedTask(h.prisma, 'T-java', { required_capabilities: ['language:java'] });

    expect((await h.claims.claim(CLAIM, tokenGo)).reason).toBe('all_blocked');
    const listed = await h.claims.listReady(listReadyQuerySchema.parse({}), tokenGo);
    expect(listed.items).toEqual([]);
    expect(listed.count).toBe(0);
    // 「看不见」不能靠写库实现：这一趟认领没留任何痕迹。
    expect(await h.prisma.taskRun.count()).toBe(0);
    expect(await h.prisma.auditLog.count()).toBe(0);
  });

  it('声明 ["language:java","tool:maven"] 的 Token 能领（子集判定，多余能力不影响）', async () => {
    await seedTask(h.prisma, 'T-java', { required_capabilities: ['language:java'] });

    const result = await h.claims.claim(CLAIM, tokenJava);
    expect(result.task?.id).toBe('T-java');
    expect(result.task?.required_capabilities).toEqual(['language:java']);
  });

  it('required 含两项时缺一个就整体不可领', async () => {
    await seedTask(h.prisma, 'T-java', {
      required_capabilities: ['language:java', 'tool:gradle'],
    });

    expect((await h.claims.claim(CLAIM, tokenJava)).reason).toBe('all_blocked');
    expect(await h.prisma.taskRun.count()).toBe(0);
  });

  it('required 为空对任何 Token 可见可领', async () => {
    await seedTask(h.prisma, 'T-any', { required_capabilities: [] });

    expect((await h.claims.claim(CLAIM, tokenGo)).task?.id).toBe('T-any');
  });

  it('能力不匹配的任务被跳过后，队里下一个可领的仍会领到', async () => {
    await seedTask(h.prisma, 'T-java', { required_capabilities: ['language:java'] });
    await seedTask(h.prisma, 'T-any', { required_capabilities: [] });

    expect((await h.claims.claim(CLAIM, tokenGo)).task?.id).toBe('T-any');
  });

  it('入参显式声明能力时可临时越过 Token 的默认集（20.5）', async () => {
    await seedTask(h.prisma, 'T-java', { required_capabilities: ['language:java'] });

    const listOverride = listReadyQuerySchema.parse({ capabilities: ['language:java'] });
    expect((await h.claims.listReady(listOverride, tokenGo)).count).toBe(1);

    const override = claimSchema.parse({ capabilities: ['language:java'] });
    expect((await h.claims.claim(override, tokenGo)).task?.id).toBe('T-java');
  });

  it('task_types 过滤与能力过滤同向：不匹配即不可见不可领', async () => {
    await seedTask(h.prisma, 'T-bug', { type: '缺陷' });

    const onlyFeature = claimSchema.parse({ task_types: ['需求'] });
    expect((await h.claims.claim(onlyFeature, tokenGo)).reason).toBe('all_blocked');
    const listFeature = listReadyQuerySchema.parse({ task_types: ['需求'] });
    expect((await h.claims.listReady(listFeature, tokenGo)).count).toBe(0);

    const onlyBug = claimSchema.parse({ task_types: ['缺陷'] });
    expect((await h.claims.claim(onlyBug, tokenGo)).task?.id).toBe('T-bug');
  });

  it('已租出且租约未过期的任务对其他 Token 也不可见', async () => {
    await seedTask(h.prisma, 'T-1');
    await h.claims.claim(CLAIM, tokenGo);

    const listed = await h.claims.listReady(listReadyQuerySchema.parse({}), tokenJava);
    expect(listed.count).toBe(0);
  });
});
