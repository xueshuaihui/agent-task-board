import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { RequestAuth } from '../../auth/auth.scope';
import { callAgentTool } from '../../mcp/mcp.server';
import { createAgentHarness, type AgentHarness } from '../../agent/__tests__/temp-db';

/**
 * v0.0.4 W7 §16.1：board.* 拆解五工具的 MCP 面测试。
 * 生命周期分支（技能解析、成环拒绝、全成全滚）已在 breakdown.test.ts 的服务层覆盖，
 * 这里验的是「工具名 → 服务方法」映射本身：入参 schema、鉴权组、错误载荷与读回形状。
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
  settings: h.settings,
});

function call(name: string, args: Record<string, unknown>, auth: RequestAuth = agent) {
  return callAgentTool(toolCtx(), auth, name, args);
}

const unknownSession = () => randomUUID();

beforeAll(async () => {
  h = createAgentHarness();
  agent = await h.agent('qoder-board', []);
});

afterAll(async () => {
  await h?.dispose();
});

describe('board.begin_breakdown', () => {
  it('成功：receiving 会话落库，agent_name 缺省取凭证名（§7.3 渲染来源）', async () => {
    const session = (await call('board.begin_breakdown', {
      requirement_text: '实现优惠券功能',
      parent_title: '优惠券功能',
      estimated_tasks: 3,
    })) as { id: string; status: string; agent_name: string };
    expect(session.status).toBe('receiving');
    expect(session.agent_name).toBe('qoder-board');
    const rows = await h.prisma.$queryRawUnsafe<{ n: number }[]>(
      `SELECT COUNT(*) AS n FROM breakdown_sessions WHERE id = ?`,
      session.id,
    );
    expect(Number(rows[0]!.n)).toBe(1);
  });

  it('错误：requirement_text 空白被 VALIDATION_FAILED 挡下；UI Token 越界回 FORBIDDEN', async () => {
    await expect(
      call('board.begin_breakdown', { requirement_text: '   ', parent_title: 'x' }),
    ).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
    await expect(
      call('board.begin_breakdown', { requirement_text: 'r', parent_title: 'x' }, ui),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
  });
});

describe('board.report_progress / board.report_task_draft / board.finish_breakdown 主链路', () => {
  let sessionId: string;

  beforeAll(async () => {
    const session = (await call('board.begin_breakdown', {
      requirement_text: '报表导出',
      parent_title: '报表导出需求',
    })) as { id: string };
    sessionId = session.id;
  });

  it('report_progress 成功：{recorded:true} 且进度行落库', async () => {
    const result = await call('board.report_progress', {
      session_id: sessionId,
      step: 2,
      total: 5,
      message: '识别工作单元',
    });
    expect(result).toEqual({ recorded: true });
    const detail = await h.breakdown.get(sessionId);
    expect(detail.progress).toHaveLength(1);
    expect(detail.progress[0]).toMatchObject({ step: 2, total: 5, message: '识别工作单元' });
  });

  it('report_progress 错误：step > total 回 VALIDATION_FAILED；未知会话回 NOT_FOUND', async () => {
    await expect(
      call('board.report_progress', { session_id: sessionId, step: 6, total: 5 }),
    ).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
    await expect(
      call('board.report_progress', { session_id: unknownSession(), step: 1, total: 1 }),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });

  it('report_task_draft 成功：返回草案 DTO；同 ref 重报即覆盖（§7.6）', async () => {
    const draft = (await call('board.report_task_draft', {
      session_id: sessionId,
      ref: 'd1',
      title: '导出接口',
      skill_ids: ['代码审查'],
      depends_on: [],
    })) as { ref: string; title: string; skill_ids: string[] };
    expect(draft).toMatchObject({ ref: 'd1', title: '导出接口', skill_ids: ['代码审查'] });

    const revised = (await call('board.report_task_draft', {
      session_id: sessionId,
      ref: 'd1',
      title: '导出接口（修订）',
      // 整体覆盖语义（§7.6）：重报要带上全部字段，否则 skill_ids 会被清成空。
      skill_ids: ['代码审查'],
    })) as { title: string };
    expect(revised.title).toBe('导出接口（修订）');
    const detail = await h.breakdown.get(sessionId);
    expect(detail.drafts.filter((d) => d.ref === 'd1')).toHaveLength(1);
  });

  it('report_task_draft 错误：依赖自身回 DEPENDENCY_CYCLE；priority 越界回 VALIDATION_FAILED', async () => {
    await expect(
      call('board.report_task_draft', { session_id: sessionId, ref: 'd2', title: 'x', depends_on: ['d2'] }),
    ).rejects.toMatchObject({ code: 'DEPENDENCY_CYCLE' });
    await expect(
      call('board.report_task_draft', { session_id: sessionId, ref: 'd3', title: 'x', priority: 9 }),
    ).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
  });

  it('finish_breakdown 成功：转 reviewing 并带 skill_resolution 报告（§7.5）', async () => {
    const finished = (await call('board.finish_breakdown', { session_id: sessionId })) as {
      session: { status: string; actual_tasks: number };
      skill_resolution: { ambiguous: unknown[]; unresolved: { name: string }[] };
    };
    expect(finished.session.status).toBe('reviewing');
    expect(finished.session.actual_tasks).toBe(1);
    // 表里没有叫「代码审查」的技能 → unresolved 告警不阻断（服务层语义，工具面透传）。
    expect(finished.skill_resolution.unresolved).toEqual([{ ref: 'd1', name: '代码审查' }]);
  });

  it('finish 之后再动：progress/draft/finish 统一 BREAKDOWN_BAD_STATE（409 语义）', async () => {
    for (const [name, args] of [
      ['board.report_progress', { session_id: sessionId, step: 1, total: 1 }],
      ['board.report_task_draft', { session_id: sessionId, ref: 'd9', title: '迟到的草案' }],
      ['board.finish_breakdown', { session_id: sessionId }],
    ] as const) {
      await expect(call(name, args)).rejects.toMatchObject({ code: 'BREAKDOWN_BAD_STATE' });
    }
  });
});

describe('board.cancel_breakdown', () => {
  it('成功：receiving 直接取消，转 cancelled', async () => {
    const session = (await call('board.begin_breakdown', {
      requirement_text: '半途需求',
      parent_title: '半途需求',
    })) as { id: string };
    const cancelled = (await call('board.cancel_breakdown', { session_id: session.id })) as {
      id: string;
      status: string;
      cancelled_at: string | null;
    };
    expect(cancelled).toMatchObject({ id: session.id, status: 'cancelled' });
    expect(cancelled.cancelled_at).not.toBeNull();
  });

  it('错误：重复取消回 BREAKDOWN_BAD_STATE；未知会话回 NOT_FOUND', async () => {
    const session = (await call('board.begin_breakdown', {
      requirement_text: '取消两次',
      parent_title: '取消两次',
    })) as { id: string };
    await call('board.cancel_breakdown', { session_id: session.id });
    await expect(call('board.cancel_breakdown', { session_id: session.id })).rejects.toMatchObject({
      code: 'BREAKDOWN_BAD_STATE',
    });
    await expect(
      call('board.cancel_breakdown', { session_id: unknownSession() }),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });
});
