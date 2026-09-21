import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ApiException } from '../../contract/errors';
import { BreakdownService } from '../../breakdown/breakdown.service';
import { createTestApp, type TestApp } from '../../__tests__/helpers/http-app';
import { BreakdownTimeoutJob } from '../breakdown-timeout.job';

/**
 * W7 遗留 b2：拆解超时收敛（§7.7 两条超时边 + §7.8 边界表 + 20.3-10）。
 * 时钟注入走 runOnce(now) 的口径等价物——测试把时间戳回拨（datetime('now','-N …')），
 * runOnce 用默认 now，与 AutoArchiveJob 测试同一手法。
 */
let t: TestApp;
let svc: BreakdownService;
let job: BreakdownTimeoutJob;

beforeAll(async () => {
  t = await createTestApp();
  svc = t.app.get(BreakdownService);
  job = t.app.get(BreakdownTimeoutJob);
});

afterAll(async () => {
  await t?.close();
});

async function closeSession(sessionId: string): Promise<void> {
  const rows = await t.prisma.$queryRawUnsafe<{ n: bigint }[]>(
    `SELECT COUNT(*) AS n FROM audit_logs WHERE action = 'breakdown_timeout' AND target_id = ?`,
    sessionId,
  );
  expect(Number(rows[0]!.n)).toBeGreaterThanOrEqual(1);
}

function status(sessionId: string): Promise<string> {
  return svc.requireSession(sessionId).then((s) => s.status);
}

describe('挂载与幂等', () => {
  it('应用 bootstrap 即挂上周期定时器（进程启动即挂载）', () => {
    expect(job.scheduled()).toBe(true);
  });
});

describe('边 1：receiving 断连 30 分钟 → interrupted（§7.7/§7.8）', () => {
  it('最后活动（created_at 与最新 progress 取大）超 30 分钟才收；新一轮中断不误伤', async () => {
    const stale = await svc.begin({ requirement_text: '断连会话', parent_title: '断连需求' });
    await t.prisma.$executeRawUnsafe(
      `UPDATE breakdown_sessions SET created_at = datetime('now', '-31 minutes') WHERE id = ?`,
      stale.id,
    );
    const fresh = await svc.begin({ requirement_text: '活着', parent_title: '活跃需求' });
    // 老会话但刚上报过进度：progress.created_at 是活动信号，不该被收。
    const revived = await svc.begin({ requirement_text: '刚汇报', parent_title: '续命需求' });
    await t.prisma.$executeRawUnsafe(
      `UPDATE breakdown_sessions SET created_at = datetime('now', '-31 minutes') WHERE id = ?`,
      revived.id,
    );
    await svc.reportProgress(revived.id, { step: 1, total: 3 });

    const outcome = await job.runOnce();
    expect(outcome.interrupted).toEqual([{ id: stale.id, from: 'receiving', reason: 'Agent 断连超 30 分钟（§7.7/§7.8）' }]);
    expect(await status(stale.id)).toBe('interrupted');
    expect(await status(fresh.id)).toBe('receiving');
    expect(await status(revived.id)).toBe('receiving');
    await closeSession(stale.id);

    // 幂等：再跑一轮不重复收、不重复审计。
    const second = await job.runOnce();
    expect(second.interrupted.find((item) => item.id === stale.id)).toBeUndefined();
    expect(await status(stale.id)).toBe('interrupted');
  });

  it('interrupted 会话不可再 cancel/confirm（终态）', async () => {
    const stale = await svc.begin({ requirement_text: '已中断', parent_title: '中断终态' });
    await t.prisma.$executeRawUnsafe(
      `UPDATE breakdown_sessions SET created_at = datetime('now', '-31 minutes') WHERE id = ?`,
      stale.id,
    );
    await job.runOnce();
    await expect(svc.cancel(stale.id)).rejects.toBeInstanceOf(ApiException);
    await expect(svc.confirm(stale.id)).rejects.toMatchObject({ code: 'BREAKDOWN_BAD_STATE' });
  });
});

describe('边 2：reviewing 用户 7 天未确认 → interrupted（§7.7 + 20.3-10）', () => {
  async function reviewing(): Promise<string> {
    const session = await svc.begin({ requirement_text: '待确认', parent_title: `待确认 ${Math.random().toString(36).slice(2, 8)}` });
    await svc.reportDraft(session.id, { ref: 'd1', title: '子项' });
    await svc.finish(session.id);
    return session.id;
  }

  it('定时收敛：finished_at 超 7 天转 interrupted，6 天的不动', async () => {
    const expired = await reviewing();
    const kept = await reviewing();
    await t.prisma.$executeRawUnsafe(
      `UPDATE breakdown_sessions SET finished_at = datetime('now', '-8 days') WHERE id = ?`,
      expired,
    );
    await t.prisma.$executeRawUnsafe(
      `UPDATE breakdown_sessions SET finished_at = datetime('now', '-6 days') WHERE id = ?`,
      kept,
    );
    const outcome = await job.runOnce();
    expect(outcome.interrupted).toEqual([
      { id: expired, from: 'reviewing', reason: '用户超 7 天未确认（20.3-10）' },
    ]);
    expect(await status(expired)).toBe('interrupted');
    expect(await status(kept)).toBe('reviewing');

    // 20.3-10：到期草案可查——GET 详情仍完整。
    const detail = await svc.get(expired);
    expect(detail.drafts).toHaveLength(1);
    expect(detail.session.status).toBe('interrupted');
  });

  it('confirm 兜底：定时未跑到的超期窗口，confirm 自身拦截并就地标 interrupted', async () => {
    const expired = await reviewing();
    await t.prisma.$executeRawUnsafe(
      `UPDATE breakdown_sessions SET finished_at = datetime('now', '-8 days') WHERE id = ?`,
      expired,
    );
    await expect(svc.confirm(expired)).rejects.toMatchObject({
      code: 'BREAKDOWN_BAD_STATE',
      status: 409,
    });
    expect(await status(expired)).toBe('interrupted');
    await closeSession(expired);
    // 收敛后重复 confirm 走的是终态 409（同一 code，不再计新审计）。
    await expect(svc.confirm(expired)).rejects.toMatchObject({ code: 'BREAKDOWN_BAD_STATE' });
  });
});

describe('不越界：creating/completed/cancelled 无超时边（§7.7 图只有两条）', () => {
  it('completed 会话时间戳再老也不被收', async () => {
    const session = await svc.begin({ requirement_text: '已建任务', parent_title: '完成不受损' });
    await svc.reportDraft(session.id, { ref: 'd1', title: '子项' });
    await svc.finish(session.id);
    await svc.confirm(session.id);
    await t.prisma.$executeRawUnsafe(
      `UPDATE breakdown_sessions SET created_at = datetime('now', '-40 days'), finished_at = datetime('now', '-40 days') WHERE id = ?`,
      session.id,
    );
    const outcome = await job.runOnce();
    expect(outcome.interrupted.find((item) => item.id === session.id)).toBeUndefined();
    expect(await status(session.id)).toBe('completed');
  });
});
