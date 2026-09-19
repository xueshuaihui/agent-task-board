import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { STATUS_LABEL, TASK_STATUS, type TaskStatus } from '../contract/enums';
import { USER_COPY } from '../contract/errors';
import { classifyTransition, isDirectTransition } from '../contract/transitions';
import { createTestApp, errorCode, errorMessage, type TestApp } from './helpers/http-app';
import {
  API,
  approve,
  claimOk,
  clearReadyQueue,
  newTask,
  taskIn,
  triple,
  uiSender,
} from './helpers/seed';

/**
 * 4.5 拖拽矩阵的服务端侧：三十六个 (源列, 目标列) 组合逐个打 `POST /tasks/:id/transition`。
 *
 * 期望表按文档 4.5 手抄（direct / 🔒form / ❌ 三类），不引用实现的 classifyTransition ——
 * 抄一遍才有意义：矩阵改了一处而忘了改文案，这里就会红。实现里的纯函数另外单独对表。
 *
 * 三种拒绝的 HTTP 形状都是 409 ILLEGAL_TRANSITION，区别只在 message：
 * 4.5 明确「Toast 文案由服务端统一给」，所以 message 必须逐字相等。
 */
type Cell =
  | 'direct'
  | 'form:review'
  | 'form:stop'
  | 'forbid:running'
  | 'forbid:done'
  | 'forbid:self'
  | 'forbid:illegal';

const MATRIX_45: Record<TaskStatus, Record<TaskStatus, Cell>> = {
  BACKLOG: {
    BACKLOG: 'forbid:self',
    READY: 'direct',
    RUNNING: 'forbid:running',
    BLOCKED: 'forbid:illegal',
    REVIEW: 'forbid:illegal',
    DONE: 'forbid:illegal',
    FAILED: 'forbid:illegal',
  },
  READY: {
    BACKLOG: 'direct',
    READY: 'forbid:self',
    RUNNING: 'forbid:running',
    BLOCKED: 'forbid:illegal',
    REVIEW: 'forbid:illegal',
    DONE: 'forbid:illegal',
    FAILED: 'forbid:illegal',
  },
  RUNNING: {
    BACKLOG: 'forbid:running',
    READY: 'forbid:running',
    RUNNING: 'forbid:self',
    // 8.4：RUNNING→BLOCKED 由 Agent 端 POST /tasks/:id/blocked 产生，不走 transition。
    BLOCKED: 'forbid:running',
    REVIEW: 'forbid:running',
    DONE: 'forbid:running',
    FAILED: 'form:stop',
  },
  BLOCKED: {
    BACKLOG: 'direct',
    READY: 'direct',
    RUNNING: 'forbid:running',
    BLOCKED: 'forbid:self',
    REVIEW: 'forbid:illegal',
    DONE: 'forbid:illegal',
    FAILED: 'forbid:illegal',
  },
  REVIEW: {
    BACKLOG: 'form:review',
    READY: 'form:review',
    RUNNING: 'forbid:running',
    BLOCKED: 'forbid:illegal',
    REVIEW: 'forbid:self',
    DONE: 'form:review',
    FAILED: 'forbid:illegal',
  },
  DONE: {
    BACKLOG: 'forbid:done',
    READY: 'forbid:done',
    RUNNING: 'forbid:done',
    BLOCKED: 'forbid:done',
    REVIEW: 'forbid:done',
    DONE: 'forbid:self',
    FAILED: 'forbid:done',
  },  FAILED: {
    BACKLOG: 'direct',
    READY: 'direct',
    RUNNING: 'forbid:running',
    BLOCKED: 'forbid:illegal',
    REVIEW: 'forbid:illegal',
    DONE: 'forbid:illegal',
    FAILED: 'forbid:self',
  },
};

function expectedCopy(from: TaskStatus, to: TaskStatus, cell: Cell): string {
  switch (cell) {
    case 'form:stop':
    case 'forbid:running':
      return USER_COPY.dragToRunning;
    case 'forbid:done':
      return USER_COPY.dragOutOfDone;
    case 'forbid:self':
      return '源列与目标列相同';
    case 'form:review':
      return '该流转需要填写审核表单';
    default:
      return `不允许从「${STATUS_LABEL[from]}」流转到「${STATUS_LABEL[to]}」`;
  }
}

let t: TestApp;
let ui: ReturnType<typeof uiSender>;

beforeAll(async () => {
  t = await createTestApp();
  ui = uiSender(t);
}, 60_000);

afterAll(async () => {
  await t?.close();
});

describe('4.5 拖拽矩阵全组合', () => {
  for (const from of TASK_STATUS) {
    it(`从「${STATUS_LABEL[from]}」出发的六个目标全部符合矩阵`, async () => {
      for (const to of TASK_STATUS) {
        const cell = MATRIX_45[from][to];
        const fixture = await taskIn(t, from, `矩阵 ${from}→${to}`);
        const res = await ui.post(`${API}/tasks/${fixture.id}/transition`, { to });

        if (cell === 'direct') {
          expect(res.status, `${from}→${to} 应当直接生效`).toBe(201);
          expect(res.body.status).toBe(to);
          expect(await (await ui.get(`${API}/tasks/${fixture.id}`)).body.status).toBe(to);
          continue;
        }

        expect(res.status, `${from}→${to} 矩阵判定为 ${cell}`).toBe(409);
        expect(errorCode(res)).toBe('ILLEGAL_TRANSITION');
        expect(errorMessage(res), `${from}→${to} 的文案`).toBe(expectedCopy(from, to, cell));
        if (cell === 'form:review') expect(res.body.error.requires).toBe('review');
        if (cell === 'form:stop') expect(res.body.error.requires).toBe('stop');
        // 拒绝必须是零写入：任务还停在原列。
        expect(await (await ui.get(`${API}/tasks/${fixture.id}`)).body.status).toBe(from);
      }
    }, 30_000);
  }

  it('实现里的纯函数与手抄表逐格一致（防止矩阵与文案分叉）', () => {
    for (const from of TASK_STATUS) {
      for (const to of TASK_STATUS) {
        const cell = MATRIX_45[from][to];
        const verdict = classifyTransition(from, to);
        if (cell === 'direct') {
          expect(verdict, `${from}→${to}`).toEqual({ kind: 'direct' });
          expect(isDirectTransition(from, to)).toBe(true);
        } else if (cell === 'form:review' || cell === 'form:stop') {
          expect(verdict, `${from}→${to}`).toEqual({ kind: 'form', form: cell.split(':')[1] });
          expect(isDirectTransition(from, to), `${from}→${to} 不能走 transition 端点`).toBe(false);
        } else {
          expect(verdict.kind, `${from}→${to}`).toBe('forbidden');
          const reason =
            cell === 'forbid:running'
              ? 'running-by-agent'
              : cell === 'forbid:done'
                ? 'done-terminal'
                : cell === 'forbid:self'
                  ? 'self'
                  : 'illegal';
          expect((verdict as { reason: string }).reason, `${from}→${to}`).toBe(reason);
        }
      }
    }
  });

  it('到执行中没有例外：五个源列一律被 transition 拒绝（4.3.1 规则 2）', async () => {
    await clearReadyQueue(t);
    // RUNNING→RUNNING 是「源列与目标列相同」那一格，已由上面的全组合覆盖。
    for (const from of TASK_STATUS.filter((status) => status !== 'RUNNING')) {
      const fixture = await taskIn(t, from, `禁止拖入执行中 ${from}`);
      const res = await ui.post(`${API}/tasks/${fixture.id}/transition`, { to: 'RUNNING' });
      expect(res.status, `${from}→RUNNING`).toBe(409);
      // 状态机先判终态：DONE 出发命中「已完成是终态」，走不到 RUNNING 专属那条文案。
      expect(
        errorMessage(res),
        `${from}→RUNNING`,
      ).toBe(from === 'DONE' ? USER_COPY.dragOutOfDone : USER_COPY.dragToRunning);
    }
  });
});

describe('执行中与终态的额外约束', () => {
  it('执行中的任务不可编辑、不可删除、不可停止以外的任何操作', async () => {
    const { id, agent, key } = await taskIn(t, 'RUNNING', '执行中的锁');
    expect(key).not.toBeNull();

    const patch = await ui.patch(`${API}/tasks/${id}`, { title: '改个名' });
    expect(patch.status).toBe(409);
    expect(errorCode(patch)).toBe('TASK_RUNNING');
    expect(errorMessage(patch)).toBe('执行中的任务不可编辑，请先强制停止');

    const del = await ui.del(`${API}/tasks/${id}`);
    expect(del.status).toBe(409);
    expect(errorCode(del)).toBe('TASK_RUNNING');
    expect((await ui.get(`${API}/tasks/${id}`)).body.title).not.toBe('改个名');

    // 13 章没有 force 语义：加 ?force=true 也改不了「执行中不可删除」。
    const forced = await ui.del(`${API}/tasks/${id}?force=true`);
    expect(forced.status).toBe(409);
    expect(errorCode(forced)).toBe('TASK_RUNNING');
    expect(errorMessage(forced)).toBe('执行中的任务不可删除，请先强制停止');
    // 租约仍在，Agent 还能续租，说明拒绝路径没有半写状态。
    const beat = await agent.claims.post(`${API}/tasks/${id}/heartbeat`, key!);
    expect(beat.status).toBe(200);

    const stopped = await ui.post(`${API}/tasks/${id}/stop`, { reason: '集成测试收尾' });
    expect(stopped.status).toBe(201);
    expect(stopped.body.status).toBe('FAILED');
    expect((await ui.del(`${API}/tasks/${id}?force=true`)).status).toBe(200);
  });

  it('非执行中的任务不需要停止：stop 回 409 TASK_NOT_RUNNING', async () => {
    for (const status of ['BACKLOG', 'READY', 'BLOCKED', 'REVIEW', 'DONE', 'FAILED'] as const) {
      const fixture = await taskIn(t, status, `无需停止 ${status}`);
      const res = await ui.post(`${API}/tasks/${fixture.id}/stop`, {});
      expect(res.status, `${status} 不该能停止`).toBe(409);
      expect(errorCode(res)).toBe('TASK_NOT_RUNNING');
      expect(errorMessage(res)).toBe('任务不在执行中，无需停止');
    }
  });

  it('已完成是终态：审核、归档以外的写入口全部关死', async () => {
    const done = await taskIn(t, 'DONE', '终态任务');

    const review = await ui.post(`${API}/tasks/${done.id}/review`, {
      conclusion: 'APPROVE',
      suggestion: '再审一次',
      reason: '理由',
      detail: '细节',
    });
    expect(review.status).toBe(409);
    expect(errorCode(review)).toBe('ILLEGAL_TRANSITION');
    expect(errorMessage(review)).toBe('只有待审核的任务可以提交审核结论');

    const archived = await ui.post(`${API}/tasks/${done.id}/archive`, {});
    expect(archived.status).toBe(201);
    expect(archived.body.archived).toBe(true);
    const restored = await ui.post(`${API}/tasks/${done.id}/restore`, {});
    expect(restored.status).toBe(201);
    expect(restored.body.status).toBe('DONE');

    // 已完成可编辑（终态不是锁），但不能被拖回任何列。
    const back = await ui.post(`${API}/tasks/${done.id}/transition`, { to: 'READY' });
    expect(back.status).toBe(409);
    expect(errorMessage(back)).toBe(USER_COPY.dragOutOfDone);
  });

  it('只有已完成可以归档，其余五列一律 409', async () => {
    for (const status of ['BACKLOG', 'READY', 'RUNNING', 'BLOCKED', 'REVIEW', 'FAILED'] as const) {
      const fixture = await taskIn(t, status, `不能归档 ${status}`);
      const res = await ui.post(`${API}/tasks/${fixture.id}/archive`, {});
      expect(res.status, `${status} 不该能归档`).toBe(409);
      expect(errorCode(res)).toBe('ILLEGAL_TRANSITION');
      expect(errorMessage(res)).toBe('只有已完成的任务可以归档');
    }
  });

  it('批量流转逐条判定：合法项生效，非法项带着原因进 skipped（6.13）', async () => {
    await clearReadyQueue(t);
    const okId = await newTask(t, { title: '批量可移' });
    const done = await taskIn(t, 'DONE', '批量不动');
    const running = await taskIn(t, 'RUNNING', '批量也不动');

    const res = await ui.post(`${API}/tasks/batch/transition`, { ids: [okId, done.id, running.id], to: 'READY' });
    expect(res.status).toBe(201);
    expect(res.body.succeeded).toEqual([okId]);
    expect(res.body.skipped).toHaveLength(2);
    expect(res.body.skipped.map((s: { id: string }) => s.id).sort()).toEqual(
      [done.id, running.id].sort(),
    );
    for (const item of res.body.skipped as { id: string; reason: string }[]) {
      expect(item.reason).toContain('ILLEGAL_TRANSITION');
    }
    expect((await ui.get(`${API}/tasks/${okId}`)).body.status).toBe('READY');
    expect((await ui.get(`${API}/tasks/${done.id}`)).body.status).toBe('DONE');
    expect((await ui.get(`${API}/tasks/${running.id}`)).body.status).toBe('RUNNING');
  });

  it('不存在的任务：404 NOT_FOUND，而不是拿 null 去判矩阵', async () => {
    const res = await ui.post(`${API}/tasks/T-0000FFFF/transition`, { to: 'READY' });
    expect(res.status).toBe(404);
    expect(errorCode(res)).toBe('NOT_FOUND');
    expect(errorMessage(res)).toBe('任务不存在');
    const gone = await ui.get(`${API}/tasks/T-0000FFFF`);
    expect(gone.status).toBe(404);
  });

  it('审核退回只能是需求池或待执行；退回后旧三元组作废、可被重新认领', async () => {
    const fixture = await taskIn(t, 'REVIEW', '驳回后再跑');
    const stale = { ...fixture.key! };

    const rejected = await ui.post(`${API}/tasks/${fixture.id}/review`, {
      conclusion: 'REJECT',
      suggestion: '补一下边界',
      reason: '并发场景没测',
      detail: '加上双 Token 并发的用例',
      return_to: 'READY',
    });
    expect(rejected.status).toBe(201);
    expect(rejected.body.status).toBe('READY');
    expect(rejected.body.status_label).toBe('待执行');
    const reviews = await ui.get(`${API}/tasks/${fixture.id}/reviews`);
    expect(reviews.body.items[0]).toMatchObject({ conclusion: 'REJECT', return_to: 'READY' });

    // 4.4：驳回让任务回到待执行，但上一轮 Run 的 lease_id 再也换不回写入权。
    const staleWrite = await fixture.agent.claims.post(
      `${API}/tasks/${fixture.id}/progress`,
      { ...stale, progress: 90 },
    );
    expect(staleWrite.status).toBe(410);
    expect(errorCode(staleWrite)).toBe('LEASE_EXPIRED');
    expect(errorMessage(staleWrite)).toBe(USER_COPY.leaseExpired);

    const again = await claimOk(fixture.agent, fixture.id);
    expect(again.lease_id).not.toBe(stale.lease_id);
    const completed = await fixture.agent.claims.post(`${API}/tasks/${fixture.id}/complete`, {
      ...triple(again),
      summary: '补了并发用例',
      artifacts: [],
    });
    expect(completed.status).toBe(200);
    await approve(t, fixture.id);
    expect((await ui.get(`${API}/tasks/${fixture.id}`)).body.status_label).toBe('已完成');
  });

  it('驳回未指定退回目标 → 默认退回待执行；通过却带退回目标 → 422（13 章入参校验）', async () => {
    const fixture = await taskIn(t, 'REVIEW', '审核表单校验');
    const missing = await ui.post(`${API}/tasks/${fixture.id}/review`, {
      conclusion: 'REJECT',
      suggestion: '补边界',
      reason: '缺测试',
      detail: '加用例',
    });
    // 21.5-42：驳回 → 按选择回到待执行（默认），未指定时退回 READY。
    expect(missing.status).toBe(201);
    expect(missing.body.status).toBe('READY');
    expect(missing.body.status_label).toBe('待执行');
    const reviews = await ui.get(`${API}/tasks/${fixture.id}/reviews`);
    expect(reviews.body.items[0]).toMatchObject({ conclusion: 'REJECT', return_to: 'READY' });

    const fixture2 = await taskIn(t, 'REVIEW', '审核表单校验-通过带退回');
    const extra = await ui.post(`${API}/tasks/${fixture2.id}/review`, {
      conclusion: 'APPROVE',
      suggestion: '做得好',
      reason: '符合要求',
      detail: '干净',
      return_to: 'READY',
    });
    expect(extra.status).toBe(422);
    expect(JSON.stringify(extra.body.error.details)).toContain('return_to');
    // 校验失败不该动任务状态。
    expect((await ui.get(`${API}/tasks/${fixture2.id}`)).body.status).toBe('REVIEW');
  });

  it('驳回显式传入非法退回目标 → 422；显式传需求池则退回需求池', async () => {
    const fixture = await taskIn(t, 'REVIEW', '非法退回目标');
    const bad = await ui.post(`${API}/tasks/${fixture.id}/review`, {
      conclusion: 'REJECT',
      suggestion: '补边界',
      reason: '缺测试',
      detail: '加用例',
      return_to: 'DONE',
    });
    expect(bad.status).toBe(422);
    expect(errorCode(bad)).toBe('VALIDATION_FAILED');
    expect((await ui.get(`${API}/tasks/${fixture.id}`)).body.status).toBe('REVIEW');

    const toBacklog = await ui.post(`${API}/tasks/${fixture.id}/review`, {
      conclusion: 'REJECT',
      suggestion: '补边界',
      reason: '缺测试',
      detail: '加用例',
      return_to: 'BACKLOG',
    });
    expect(toBacklog.status).toBe(201);
    expect(toBacklog.body.status).toBe('BACKLOG');
  });
});
