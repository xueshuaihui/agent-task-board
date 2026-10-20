import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { RequestAuth } from '../../auth/auth.scope';
import { callAgentTool } from '../../mcp/mcp.server';
import { createAgentHarness, type AgentHarness } from '../../agent/__tests__/temp-db';
import type { CreationRequestView } from '../creation.service';

/**
 * #5 后端片：审核方式的 Agent 请求面与用户决定面（Q4 硬不变量）。
 *
 *  - Agent 只能经 `requested_review_mode` 在 light 模式提出请求；direct/silent 传它即 422。
 *  - 原始 `review_mode` / `reviewMode` 在 MCP 入口显式 422（zod 默认会静默剥离未知键）。
 *  - 只有用户的轻确认决策（decision payload 的 review_mode）能落最终值。
 *  - `parent_task_id`：父必须是未归档的「需求」顶层任务；子任务默认继承父需求分组。
 */
let h: AgentHarness;
let agent: RequestAuth;

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

const unique = (label: string) => `${label} ${Math.random().toString(36).slice(2, 8)}`;

async function countOf(table: string, where = '', params: unknown[] = []): Promise<number> {
  const rows = await h.prisma.$queryRawUnsafe<{ n: number }[]>(
    `SELECT COUNT(*) AS n FROM ${table} ${where}`,
    ...params,
  );
  return Number(rows[0]!.n);
}

interface CapturedError {
  code: string;
  details?: { path: string; code: string }[];
}

/** 抓取 ApiException 形状（Promise.catch 会把返回类型吞成 unknown，这里显式收窄）。 */
async function errorOf(promise: Promise<unknown>): Promise<CapturedError> {
  try {
    await promise;
  } catch (error) {
    return error as CapturedError;
  }
  throw new Error('期望调用失败，但实际成功');
}

const baseInput = {
  title: '创建面审核方式基线',
  description: 'Q4：执行者不得自豁免',
  type: '缺陷',
  priority: 1,
  tags: ['后端'],
  skills: [] as string[],
  session_id: 'conv-review-mode-slice',
  agent_name: 'qoder-1',
};

const GROUP_ID = 'grp_parent_test';
const PARENT_REQ_ID = 'T-9001';
const NORMAL_TASK_ID = 'T-9002';
const DEPTH_TASK_ID = 'T-9003';

beforeAll(async () => {
  h = createAgentHarness();
  agent = await h.agent('qoder-review-mode', []);

  // 父需求/普通任务/二层任务：直接写库，覆盖 parent 校验的三条拒绝支与一条成功支。
  await h.prisma.group.create({ data: { id: GROUP_ID, name: '需求归属测试组' } });
  await h.prisma.task.create({
    data: { id: PARENT_REQ_ID, type: '需求', title: '父需求', status: 'BACKLOG', groupId: GROUP_ID },
  });
  await h.prisma.task.create({
    data: { id: NORMAL_TASK_ID, type: '缺陷', title: '普通父任务', status: 'BACKLOG', groupId: GROUP_ID },
  });
  await h.prisma.task.create({
    data: {
      id: DEPTH_TASK_ID,
      type: '需求',
      title: '二层需求',
      status: 'BACKLOG',
      groupId: GROUP_ID,
      parentTaskId: PARENT_REQ_ID,
    },
  });
}, 30_000);

afterAll(async () => {
  await h?.dispose();
});

describe('requested_review_mode 仅 light 模式可用', () => {
  it('direct + requested_review_mode → 422 VALIDATION_FAILED，任务未创建', async () => {
    const title = unique('direct-requested');
    await expect(
      call('board.create_task', {
        ...baseInput,
        title,
        confirmation_mode: 'direct',
        requested_review_mode: 'none',
      }),
    ).rejects.toMatchObject({
      code: 'VALIDATION_FAILED',
      details: [expect.objectContaining({ path: 'requested_review_mode' })],
    });
    expect(await countOf('tasks', 'WHERE title = ?', [title])).toBe(0);
  });

  it('silent + requested_review_mode → 422，任务未创建', async () => {
    const title = unique('silent-requested');
    await expect(
      call('board.create_task', {
        ...baseInput,
        title,
        session_id: 'conv-review-mode-silent',
        confirmation_mode: 'silent',
        requested_review_mode: 'human',
      }),
    ).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
    expect(await countOf('tasks', 'WHERE title = ?', [title])).toBe(0);
  });

  it('light 请求 → 待决视图回显请求值/拟用值；用户 edit 改 human、create 保留 none', async () => {
    const requestedTitle = unique('light-requested-none');
    const pending = (await call('board.create_task', {
      ...baseInput,
      title: requestedTitle,
      session_id: 'conv-review-mode-light-a',
      confirmation_mode: 'light',
      wait: false,
      requested_review_mode: 'none',
    })) as { pending?: boolean; request_id: string };
    expect(pending).toMatchObject({ created: false, pending: true, confirmation_mode: 'light' });

    const view = (await h.creation.listRequests()).find((item) => item.request_id === pending.request_id);
    expect(view).toMatchObject({
      status: 'pending',
      requested_review_mode: 'none',
      review_mode: 'none',
    });

    const edited = await h.creation.decide(pending.request_id, {
      action: 'edit',
      payload: { review_mode: 'human' },
    });
    expect(edited.status).toBe('edited');
    expect(edited.review_mode).toBe('human');
    const editedTask = await h.prisma.task.findUniqueOrThrow({ where: { id: edited.task_id! } });
    expect(editedTask.reviewMode).toBe('human');

    // 第二个请求不覆盖：用户直接 create，落库沿用 Agent 请求的 none。
    const acceptedTitle = unique('light-requested-none-accept');
    const pending2 = (await call('board.create_task', {
      ...baseInput,
      title: acceptedTitle,
      session_id: 'conv-review-mode-light-b',
      confirmation_mode: 'light',
      wait: false,
      requested_review_mode: 'none',
    })) as { request_id: string };
    const created = await h.creation.decide(pending2.request_id, { action: 'create' });
    expect(created.status).toBe('created');
    expect(created.review_mode).toBe('none');
    const createdTask = await h.prisma.task.findUniqueOrThrow({ where: { id: created.task_id! } });
    expect(createdTask.reviewMode).toBe('none');
  });
});

describe('原始 review_mode / reviewMode 在 MCP 入口显式 422', () => {
  it('board.create_task 带 review_mode → 422，details 点名 review_mode', async () => {
    const title = unique('raw-review-mode');
    const error = await errorOf(
      call('board.create_task', {
        ...baseInput,
        title,
        confirmation_mode: 'direct',
        review_mode: 'none',
      }),
    );

    expect(error).toMatchObject({ code: 'VALIDATION_FAILED' });
    expect(error.details).toEqual([
      expect.objectContaining({ path: 'review_mode', code: 'forbidden_key' }),
    ]);
    expect(await countOf('tasks', 'WHERE title = ?', [title])).toBe(0);
  });

  it('board.create_tasks_batch 的某一条带 reviewMode → 整批 422', async () => {
    const error = await errorOf(
      call('board.create_tasks_batch', {
        tasks: [
          { title: unique('batch-ok'), type: '缺陷' },
          { title: unique('batch-raw'), type: '缺陷', reviewMode: 'none' },
        ],
        session_id: 'conv-review-mode-batch',
      }),
    );

    expect(error).toMatchObject({ code: 'VALIDATION_FAILED' });
    expect(error.details).toEqual([
      expect.objectContaining({ path: 'tasks.1.reviewMode', code: 'forbidden_key' }),
    ]);
    expect(await countOf('tasks', 'WHERE origin_session_id = ?', ['conv-review-mode-batch'])).toBe(0);
  });
});

describe('服务层守卫（绕过 MCP 入口也拦得住）', () => {
  it('直接调 CreationService.createFromAgent：direct + requested_review_mode 仍 422', async () => {
    const title = unique('service-direct-requested');
    await expect(
      h.creation.createFromAgent(
        {
          ...baseInput,
          title,
          session_id: 'conv-review-mode-service',
          confirmation_mode: 'direct',
          requested_review_mode: 'none',
        },
        'qoder-service',
      ),
    ).rejects.toMatchObject({
      code: 'VALIDATION_FAILED',
      details: [expect.objectContaining({ path: 'requested_review_mode' })],
    });
    expect(await countOf('tasks', 'WHERE title = ?', [title])).toBe(0);
  });
});

describe('parent_task_id：父需求校验与分组继承', () => {
  it('direct 建子任务：parent_task_id 落库正确，未显式给 group_id 时继承父需求分组', async () => {
    const title = unique('parent-ok');
    const result = (await call('board.create_task', {
      ...baseInput,
      title,
      session_id: 'conv-parent-ok',
      confirmation_mode: 'direct',
      parent_task_id: PARENT_REQ_ID,
    })) as { task_id: string };

    const task = await h.prisma.task.findUniqueOrThrow({ where: { id: result.task_id } });
    expect(task.parentTaskId).toBe(PARENT_REQ_ID);
    expect(task.groupId).toBe(GROUP_ID);
  });

  it('父需求已归档 → 422 parent_archived', async () => {
    await h.prisma.task.update({
      where: { id: PARENT_REQ_ID },
      data: { archivedAt: '2026-01-01 00:00:00' },
    });
    try {
      const error = await errorOf(
        call('board.create_task', {
          ...baseInput,
          title: unique('parent-archived'),
          session_id: 'conv-parent-archived',
          confirmation_mode: 'direct',
          parent_task_id: PARENT_REQ_ID,
        }),
      );

      expect(error).toMatchObject({ code: 'VALIDATION_FAILED' });
      expect(error.details).toEqual([
        expect.objectContaining({ path: 'parent_task_id', code: 'parent_archived' }),
      ]);
    } finally {
      await h.prisma.task.update({ where: { id: PARENT_REQ_ID }, data: { archivedAt: null } });
    }
  });

  it('父任务不是「需求」类型 → 422 parent_type', async () => {
    const error = await errorOf(
      call('board.create_task', {
        ...baseInput,
        title: unique('parent-type'),
        session_id: 'conv-parent-type',
        confirmation_mode: 'direct',
        parent_task_id: NORMAL_TASK_ID,
      }),
    );

    expect(error).toMatchObject({ code: 'VALIDATION_FAILED' });
    expect(error.details).toEqual([
      expect.objectContaining({ path: 'parent_task_id', code: 'parent_type' }),
    ]);
  });

  it('父任务自身已有父级（第二层）→ 422 too_deep', async () => {
    const error = await errorOf(
      call('board.create_task', {
        ...baseInput,
        title: unique('parent-depth'),
        session_id: 'conv-parent-depth',
        confirmation_mode: 'direct',
        parent_task_id: DEPTH_TASK_ID,
      }),
    );

    expect(error).toMatchObject({ code: 'VALIDATION_FAILED' });
    expect(error.details).toEqual([
      expect.objectContaining({ path: 'parent_task_id', code: 'too_deep' }),
    ]);
  });

  it('不存在的父任务 → 404 NOT_FOUND', async () => {
    await expect(
      call('board.create_task', {
        ...baseInput,
        title: unique('parent-missing'),
        session_id: 'conv-parent-missing',
        confirmation_mode: 'direct',
        parent_task_id: 'T-9999',
      }),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });
});
