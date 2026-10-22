import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AgentQueryService } from '../../agent/agent-query.service';
import { ClaimService } from '../../agent/claim.service';
import { LeaseService } from '../../agent/lease.service';
import { McpPolicyService } from '../../agent/mcp-policy.service';
import { WritebackService } from '../../agent/writeback.service';
import type { RequestAuth } from '../../auth/auth.scope';
import { WakeProbeService } from '../../client-entry/wake-probe.service';
import { CreationService } from '../../creation/creation.service';
import { SettingsService } from '../../infra/settings.service';
import { buildAgentTools, parseToolInput } from '../../mcp/agent-tools';
import { SkillsService } from '../../skills/skills.service';
import { createTestApp, type TestApp } from '../../__tests__/helpers/http-app';
import { BreakdownService, type BreakdownWaitResult } from '../breakdown.service';

/**
 * #4 `board.wait_for_breakdown` 的长轮询动作判定：
 *   reviewing 无动作 → 超时；单草案/整份重生成、用户编辑 → 对应 action；
 *   afterRevision 省略时的基线语义；终态立即返回；MCP 工具注册与 schema。
 * 轮询间隔 1s，因此用例里的用户动作都在 150ms 后注入、超时上限 1-3s，不会真的等 25s。
 */
let t: TestApp;
let svc: BreakdownService;

/** 工具面只做凭证组判断（agentOf），不需要真实签发的 token 行。 */
const agentAuth: RequestAuth = {
  kind: 'agent',
  tokenId: 'token-wait-test',
  tokenName: 'wait-test-agent',
  capabilities: [],
};

beforeAll(async () => {
  t = await createTestApp();
  svc = t.app.get(BreakdownService);
}, 30_000);

afterAll(async () => {
  await t?.close();
});

const suffix = () => Math.random().toString(36).slice(2, 8);

async function beginSession(title = `#4 wait ${suffix()}`) {
  return svc.begin({ requirement_text: `${title} 的需求原文`, parent_title: title });
}

/** 造一个 reviewing 会话：begin → d1 + d2（d2 依赖 d1）→ finish，返回 finish 后的会话（revision 已含 finish 那一次）。 */
async function reviewingSession(title = `#4 wait reviewing ${suffix()}`) {
  const session = await beginSession(title);
  await svc.reportDraft(session.id, {
    ref: 'd1',
    title: `${title} · 数据模型`,
    acceptance: ['原验收'],
  });
  await svc.reportDraft(session.id, { ref: 'd2', title: `${title} · 接口`, depends_on: ['d1'] });
  const finished = await svc.finish(session.id);
  return finished.session;
}

const delay = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

describe('waitForBreakdown：reviewing 期等待用户动作', () => {
  it('无待办时轮询到超时：action=timeout、changed=false、status/revision 为当前值', async () => {
    const session = await reviewingSession();
    const started = Date.now();
    const result = await svc.waitForBreakdown(session.id, session.revision, 1);

    expect(Date.now() - started).toBeGreaterThanOrEqual(900);
    expect(result).toMatchObject({
      session_id: session.id,
      action: 'timeout',
      status: 'reviewing',
      revision: session.revision,
      changed: false,
      refs: [],
      note: null,
    });
    expect(result.message).toContain('board.wait_for_breakdown');
  });

  it('等待期间用户重生成单条草案：draft_regenerate，refs 与 notes 指名', async () => {
    const session = await reviewingSession();
    const wait = svc.waitForBreakdown(session.id, session.revision, 3);

    await delay(150);
    await svc.userRegenerateDraft(session.id, 'd1', '补登录场景');
    const result = await wait;

    expect(result.action).toBe('draft_regenerate');
    expect(result.status).toBe('reviewing');
    expect(result.changed).toBe(true);
    expect(result.refs).toEqual(['d1']);
    expect(result.note).toBe('补登录场景');
    expect(result.notes).toHaveLength(1);
    expect(result.notes[0]).toMatchObject({ ref: 'd1', note: '补登录场景' });
    expect(result.notes[0]!.requested_at).not.toBeNull();
    expect(result.message).toContain('board.report_task_draft');
  });

  it('等待期间用户整份重生成：session_regenerate，回 receiving 并带会话说明', async () => {
    const session = await reviewingSession();
    const wait = svc.waitForBreakdown(session.id, session.revision, 3);

    await delay(150);
    await svc.regenerateSession(session.id, '换微服务方案');
    const result = await wait;

    expect(result.action).toBe('session_regenerate');
    expect(result.status).toBe('receiving');
    expect(result.changed).toBe(true);
    expect(result.note).toBe('换微服务方案');
    expect([...result.refs].sort()).toEqual(['d1', 'd2']);
    expect(result.notes.map((entry) => entry.ref).sort()).toEqual(['d1', 'd2']);
    expect(result.message).toContain('board.get_breakdown');
  });

  it('等待期间用户编辑草案（无 pending）：user_edited，提示只读不要覆盖', async () => {
    const session = await reviewingSession();
    const wait = svc.waitForBreakdown(session.id, session.revision, 3);

    await delay(150);
    await svc.userUpdateDraft(session.id, 'd1', { title: '用户改过的标题' });
    const result = await wait;

    expect(result.action).toBe('user_edited');
    expect(result.status).toBe('reviewing');
    expect(result.changed).toBe(true);
    expect(result.refs).toEqual([]);
    expect(result.notes).toEqual([]);
    const draft = (await svc.get(session.id)).drafts.find((item) => item.ref === 'd1');
    expect(draft?.regeneration_pending).toBeUndefined();
    expect(result.message).toContain('不要覆盖');
  });

  it('省略 afterRevision 且已有待重生成草案：立即 draft_regenerate，changed=false', async () => {
    const session = await reviewingSession();
    await svc.userRegenerateDraft(session.id, 'd1', '补登录场景');

    const started = Date.now();
    const result = await svc.waitForBreakdown(session.id, undefined, 2);

    // 基线=调用开始时 revision，故 changed=false；待重报判定优先于「等用户动作」。
    expect(result.action).toBe('draft_regenerate');
    expect(result.refs).toEqual(['d1']);
    expect(result.changed).toBe(false);
    expect(Date.now() - started).toBeLessThan(1_500);
  });

  it('显式 afterRevision 且 revision 已更大、reviewing 无 pending：立即 user_edited', async () => {
    const session = await reviewingSession();

    const started = Date.now();
    const result = await svc.waitForBreakdown(session.id, session.revision - 1, 2);

    expect(result.action).toBe('user_edited');
    expect(result.status).toBe('reviewing');
    expect(result.changed).toBe(true);
    expect(result.revision).toBe(session.revision);
    expect(Date.now() - started).toBeLessThan(1_500);
  });
});

describe('waitForBreakdown：receiving 新会话', () => {
  it('无重生成请求时立即 receiving，提示继续上报并 finish', async () => {
    const session = await beginSession();

    const result = await svc.waitForBreakdown(session.id, undefined, 2);

    expect(result.action).toBe('receiving');
    expect(result.status).toBe('receiving');
    expect(result.changed).toBe(false);
    expect(result.message).toContain('board.finish_breakdown');
  });
});

describe('waitForBreakdown：终态立即返回', () => {
  it('cancel 后 cancelled；confirm 成功后 confirmed', async () => {
    const cancelled = await beginSession();
    await svc.cancel(cancelled.id);
    const cancelResult = await svc.waitForBreakdown(cancelled.id, cancelled.revision, 2);
    expect(cancelResult).toMatchObject({
      action: 'cancelled',
      status: 'cancelled',
      changed: true,
    });

    const reviewing = await reviewingSession();
    await svc.confirm(reviewing.id);
    const confirmResult = await svc.waitForBreakdown(reviewing.id, reviewing.revision, 2);
    expect(confirmResult.action).toBe('confirmed');
    expect(confirmResult.status).toBe('completed');
    expect(confirmResult.changed).toBe(true);
  });
});

describe('MCP 工具面：board.get_breakdown / board.wait_for_breakdown', () => {
  it('两个工具已注册，入参 schema 可解析且约束生效', async () => {
    const tools = buildAgentTools({
      claims: t.app.get(ClaimService),
      leases: t.app.get(LeaseService),
      writeback: t.app.get(WritebackService),
      query: t.app.get(AgentQueryService),
      skills: t.app.get(SkillsService),
      policy: t.app.get(McpPolicyService),
      breakdown: svc,
      creation: t.app.get(CreationService),
      settings: t.app.get(SettingsService),
      wake: t.app.get(WakeProbeService),
    });
    const byName = new Map(tools.map((tool) => [tool.name, tool]));
    const getTool = byName.get('board.get_breakdown');
    const waitTool = byName.get('board.wait_for_breakdown');
    expect(getTool).toBeDefined();
    expect(waitTool).toBeDefined();
    expect(waitTool!.description).toContain('board.report_task_draft');

    const session = await beginSession();
    const parsed = parseToolInput(waitTool!.input, {
      session_id: session.id,
      after_revision: session.revision,
      timeout_seconds: 5,
    }) as { session_id: string; after_revision: number; timeout_seconds: number };
    expect(parsed).toEqual({
      session_id: session.id,
      after_revision: session.revision,
      timeout_seconds: 5,
    });
    // zod 面 5..55：低于下限与高于上限都在协议层被挡。
    expect(() =>
      parseToolInput(waitTool!.input, { session_id: session.id, timeout_seconds: 1 }),
    ).toThrow();
    expect(() =>
      parseToolInput(waitTool!.input, { session_id: session.id, timeout_seconds: 56 }),
    ).toThrow();

    // run 映射：get 读全量详情；wait 在终态立即收口（不会真的挂 5 秒）。
    const detail = (await getTool!.run({ session_id: session.id }, agentAuth)) as {
      session: { id: string };
      drafts: unknown[];
      progress: unknown[];
    };
    expect(detail.session.id).toBe(session.id);
    expect(Array.isArray(detail.drafts)).toBe(true);
    expect(Array.isArray(detail.progress)).toBe(true);

    const cancelled = await beginSession();
    await svc.cancel(cancelled.id);
    const waited = (await waitTool!.run(
      { session_id: cancelled.id, timeout_seconds: 5 },
      agentAuth,
    )) as BreakdownWaitResult;
    expect(waited).toMatchObject({ session_id: cancelled.id, action: 'cancelled' });
  });
});
