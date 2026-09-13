import { existsSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { ApiException } from '../../contract/errors';
import { nowSql } from '../../contract/time';
import { paths } from '../../common/paths';
import { IMPORT_MAX_BYTES, type ImportResult } from '../import.service';
import {
  createDataHarness,
  exportRequest,
  importFile,
  importRequest,
  seedRun,
  seedTask,
  type DataHarness,
} from './temp-db';

/**
 * 6.12.2 导入。这一节的价值全在「不产生悬空引用」与「不整体回滚」两条上：
 * 换号后下游引用要跟着走、RUNNING 必须降级、坏一条不能带崩整包。
 */

let h: DataHarness;

beforeAll(() => {
  h = createDataHarness('atb-data-import-');
});

afterEach(async () => {
  await h.reset();
});

afterAll(async () => {
  await h.dispose();
});

function pkg(tasks: unknown[], extra: Record<string, unknown> = {}): unknown {
  return {
    version: 2,
    app_version: '1.5.0',
    exported_at: '2026-09-01T00:00:00Z',
    custom_field_defs: [],
    templates: [],
    tasks,
    ...extra,
  };
}

/** 包内任务：只给必填项，其余走 DTO 默认值。 */
function one(id: string | undefined, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    ...(id === undefined ? {} : { id }),
    title: `${id ?? '无号'} 包内标题`,
    type: '需求',
    status: 'DONE',
    priority: 2,
    ...overrides,
  };
}

function run(
  document: unknown,
  req: Record<string, unknown> = {},
): Promise<ImportResult> {
  return h.imports.run(importFile(document), importRequest(req));
}

async function thrown(promise: Promise<unknown>): Promise<unknown> {
  return promise.then(
    () => {
      throw new Error('预期抛出 ApiException，但调用成功了');
    },
    (error: unknown) => error,
  );
}

async function sequence(name: 'task' | 'run'): Promise<number> {
  const rows = await h.prisma.$queryRawUnsafe<{ next: number }[]>(
    `SELECT next FROM id_sequences WHERE name = '${name}'`,
  );
  return Number(rows[0]?.next);
}

describe('预览与冲突门', () => {
  it('dry_run 预览全程只读：不写库、不建备份、不落审计', async () => {
    await seedTask(h.prisma, 'T-1001', { status: 'DONE' });

    const result = await run(
      pkg([
        one('T-1001'),
        one('T-9001', { runs: [{ id: 'R-9001', status: 'SUCCESS' }], reviews: [{ run_id: 'R-9001', conclusion: 'APPROVE' }] }),
      ]),
      { dry_run: true },
    );

    expect(result.dry_run).toBe(true);
    expect(result.strategy).toBeNull();
    expect(result.backup).toBeNull();
    expect(result.conflicts).toEqual([
      { kind: 'task', id: 'T-1001', detail: '本地已存在同 id 任务（status=DONE）' },
    ]);
    // 预览就要把三类计数与映射给全，导入界面的「N 处冲突」靠它
    expect(result.tasks).toEqual({ new: 1, updated: 0, skipped: 1 });
    expect(result.runs).toEqual({ new: 1 });
    expect(result.reviews).toEqual({ new: 1 });
    expect(result.skipped).toEqual([{ kind: 'task', id: 'T-1001', reason: 'needs_strategy' }]);
    expect(result.imported).toEqual({ tasks: ['T-9001'], field_defs: [], templates: [] });

    expect(await h.prisma.task.count()).toBe(1);
    expect(await h.prisma.taskRun.count()).toBe(0);
    expect(await h.prisma.auditLog.count()).toBe(0);
    expect(readdirSync(paths.backupsDir())).toEqual([]);
    expect(await sequence('task')).toBe(1001);
  });

  it('有 ID 冲突但未选策略 → 409 IMPORT_ID_CONFLICT，一行不写也不产生空备份', async () => {
    await seedTask(h.prisma, 'T-1001', { status: 'DONE', title: '本地标题' });

    const error = (await thrown(run(pkg([one('T-1001')]), {}))) as ApiException;
    expect(error).toBeInstanceOf(ApiException);
    expect(error.code).toBe('IMPORT_ID_CONFLICT');
    expect(error.status).toBe(409);
    expect(error.message).toContain('1 处 ID 冲突');
    // 13 章：冲突清单直接进错误体，前端据此弹策略选择而不是再请求一次
    expect((error.toBody().error as { details: { conflicts: unknown } }).details.conflicts).toEqual([
      { kind: 'task', id: 'T-1001', detail: '本地已存在同 id 任务（status=DONE）' },
    ]);

    expect(await h.prisma.task.findUnique({ where: { id: 'T-1001' } })).toMatchObject({ title: '本地标题' });
    expect(await h.prisma.auditLog.count()).toBe(0);
    expect(readdirSync(paths.backupsDir())).toEqual([]);
  });

  it('冲突为零时策略可省略：沿用文件里的号位，并把序列抬到号位之上', async () => {
    const result = await run(pkg([one('T-2001'), one('T-5555')]));

    expect(result.strategy).toBeNull();
    expect(result.conflicts).toEqual([]);
    expect(result.id_map).toEqual({ tasks: {}, runs: {} });
    expect(result.imported.tasks).toEqual(['T-2001', 'T-5555']);
    expect(await sequence('task')).toBe(5555);
    // 序列抬到位之后，本地新建不会再撞上导入进来的号
    await seedTask(h.prisma, `T-${(await sequence('task')) + 1}`);
    expect(await h.prisma.task.count()).toBe(3);
  });
});

describe('三种冲突策略', () => {
  it('skip：冲突任务保留本地不动，指向它的依赖边按 target_skipped 丢弃', async () => {
    await seedTask(h.prisma, 'T-1001', { status: 'DONE', title: '本地不动' });

    const result = await run(
      pkg([
        one('T-1001', { title: '包里的同名任务' }),
        one('T-2001', {
          dependencies: [
            { depends_on: 'T-1001', type: 'blocks' },
            { depends_on: 'T-9999', type: 'blocks' },
          ],
        }),
      ]),
      { strategy: 'skip' },
    );

    expect(result.strategy).toBe('skip');
    expect(result.skipped).toEqual([{ kind: 'task', id: 'T-1001', reason: 'id_conflict' }]);
    expect(result.tasks).toEqual({ new: 1, updated: 0, skipped: 1 });
    expect(await h.prisma.task.findUnique({ where: { id: 'T-1001' } })).toMatchObject({
      title: '本地不动',
      status: 'DONE',
    });
    expect(result.dropped_dependencies).toEqual([
      { task_id: 'T-2001', depends_on: 'T-1001', reason: 'target_skipped' },
      { task_id: 'T-2001', depends_on: 'T-9999', reason: 'target_missing' },
    ]);
    expect(result.dependencies).toEqual({ new: 0 });
    expect(await h.prisma.taskDependency.count()).toBe(0);
  });

  it('overwrite：按 id 覆盖字段，本地 Run 历史不删、导入的 Run 以 run_number 追加', async () => {
    await seedTask(h.prisma, 'T-1001', { status: 'DONE', title: '本地旧标题', createdAt: '2026-01-01 00:00:00' });
    await seedRun(h.prisma, 'R-2001', 'T-1001', { runNumber: 3, status: 'SUCCESS', summary: '本地历史' });

    const result = await run(
      pkg([
        one('T-1001', {
          title: '包里的新标题',
          status: 'REVIEW',
          priority: 0,
          created_at: '2025-12-31T23:00:00.000Z',
          current_run_id: 'R-2001',
          runs: [{ id: 'R-2001', run_number: 1, status: 'SUCCESS', summary: '包里的 Run' }],
          reviews: [{ run_id: 'R-2001', conclusion: 'REJECT', suggestion: '补测试' }],
        }),
      ]),
      { strategy: 'overwrite' },
    );

    expect(result.tasks).toEqual({ new: 0, updated: 1, skipped: 0 });
    const task = await h.prisma.task.findUnique({ where: { id: 'T-1001' } });
    expect(task).toMatchObject({ title: '包里的新标题', status: 'REVIEW', priority: 0 });
    expect(task?.createdAt).toBe('2025-12-31 23:00:00');

    // 本地那条 Run 一个字节都没动，包里的排在它后面
    const runs = await h.prisma.taskRun.findMany({ where: { taskId: 'T-1001' }, orderBy: { runNumber: 'asc' } });
    expect(runs.map((row) => [row.id, row.runNumber, row.summary])).toEqual([
      ['R-2001', 3, '本地历史'],
      ['R-2002', 4, '包里的 Run'],
    ]);
    // 6.12.2 依赖引用改写：审核与 current_run_id 都跟着换到新 Run 上
    expect(await h.prisma.review.findFirst({ where: { taskId: 'T-1001' } })).toMatchObject({
      runId: 'R-2002',
      conclusion: 'REJECT',
    });
    expect(result.id_map.runs).toEqual({ 'R-2001': 'R-2002' });
    expect(await h.prisma.task.findUnique({ where: { id: 'T-1001' } })).toMatchObject({
      currentRunId: 'R-2002',
      runCount: 2,
    });
  });

  it('overwrite 撞上执行中的任务：拒绝覆盖并计入 skipped[TASK_RUNNING]，不产生空备份', async () => {
    await seedTask(h.prisma, 'T-1001', {
      status: 'RUNNING',
      title: '正在跑',
      leaseId: 'lease-9',
      currentRunId: 'R-2001',
    });
    await seedRun(h.prisma, 'R-2001', 'T-1001', { status: 'RUNNING', runNumber: 1, leaseId: 'lease-9' });

    const result = await run(pkg([one('T-1001', { title: '想覆盖它' })]), { strategy: 'overwrite' });

    expect(result.skipped).toEqual([{ kind: 'task', id: 'T-1001', reason: 'TASK_RUNNING' }]);
    expect(result.tasks).toEqual({ new: 0, updated: 0, skipped: 1 });
    expect(result.conflicts).toHaveLength(1);
    expect(await h.prisma.task.findUnique({ where: { id: 'T-1001' } })).toMatchObject({
      title: '正在跑',
      status: 'RUNNING',
      leaseId: 'lease-9',
    });
    // 整包没有一行要写：备份只在真有活计时才做
    expect(result.backup).toBeNull();
    expect(readdirSync(paths.backupsDir())).toEqual([]);
  });

  it('reassign：整包换号，id_map 给出 T-/R- 映射，下游引用全部跟着走', async () => {
    await seedTask(h.prisma, 'T-1001', { title: '本地同号任务' });

    const result = await run(
      pkg([
        one('T-1001', { title: '另一台机器的 T-1001' }),
        one('T-3001', {
          current_run_id: 'R-5001',
          dependencies: [{ depends_on: 'T-1001', type: 'blocks' }],
          runs: [{ id: 'R-5001', run_number: 1, status: 'SUCCESS', summary: '换号也要带上' }],
          reviews: [{ run_id: 'R-5001', conclusion: 'APPROVE' }],
        }),
      ]),
      { strategy: 'reassign' },
    );

    // 冲突为零的号位不重编，一旦有冲突就整包换号，避免一半沿用一半新编
    expect(result.id_map.tasks).toEqual({ 'T-1001': 'T-1002', 'T-3001': 'T-1003' });
    expect(result.id_map.runs).toEqual({ 'R-5001': 'R-2001' });
    expect(result.imported.tasks).toEqual(['T-1002', 'T-1003']);
    expect(result.warnings).toContain(
      'reassign：包内存在号位冲突，任务与 Run 已整包换号，映射见 id_map',
    );
    expect(result.tasks).toEqual({ new: 2, updated: 0, skipped: 0 });

    expect(await h.prisma.task.findUnique({ where: { id: 'T-1001' } })).toMatchObject({ title: '本地同号任务' });
    expect(await h.prisma.task.findUnique({ where: { id: 'T-1002' } })).toMatchObject({
      title: '另一台机器的 T-1001',
    });
    // 三条下游引用（依赖边 / 审核 run_id / current_run_id）都必须落在新号上
    const edge = await h.prisma.taskDependency.findFirst({ where: { taskId: 'T-1003' } });
    expect({ taskId: edge?.taskId, dependsOn: edge?.dependsOn }).toEqual({
      taskId: 'T-1003',
      dependsOn: 'T-1002',
    });
    expect(await h.prisma.taskRun.findFirst({ where: { taskId: 'T-1003' } })).toMatchObject({
      id: 'R-2001',
      summary: '换号也要带上',
    });
    expect(await h.prisma.review.findFirst({ where: { taskId: 'T-1003' } })).toMatchObject({ runId: 'R-2001' });
    expect(await h.prisma.task.findUnique({ where: { id: 'T-1003' } })).toMatchObject({ currentRunId: 'R-2001' });
  });

  it('reassign 下指向包外本地任务的边只能丢：不写悬空引用', async () => {
    await seedTask(h.prisma, 'T-1001', { title: '本地任务' });
    await seedTask(h.prisma, 'T-7777', { title: '另一台机器搬来的同号前置' });

    const result = await run(
      pkg([one('T-1001', { dependencies: [{ depends_on: 'T-7777', type: 'blocks' }] })]),
      { strategy: 'reassign' },
    );

    // 换号后包内号位是 T-7778；reassign 不接受包外号位的引用（同号可能是另一台机器的任务），
    // 但报告得说清它是「本地有同号任务、无法判定是不是同一个」——这要求规划期真的去查过目标 id。
    expect(result.dropped_dependencies).toEqual([
      { task_id: 'T-7778', depends_on: 'T-7777', reason: 'target_ambiguous' },
    ]);
    expect(await h.prisma.taskDependency.count()).toBe(0);
  });

  it('指向本地既有任务的边照样落库，6.12.2 要求指向「导入后真实存在」的 id', async () => {
    await seedTask(h.prisma, 'T-1001', { status: 'DONE', title: '本地前置' });

    const result = await run(pkg([one('T-2001', { dependencies: [{ depends_on: 'T-1001', type: 'blocks' }] })]));

    expect(result.dependencies).toEqual({ new: 1 });
    expect(result.dropped_dependencies).toEqual([]);
    expect(await h.prisma.taskDependency.findFirst({ where: { taskId: 'T-2001' } })).toMatchObject({
      dependsOn: 'T-1001',
      type: 'blocks',
    });

    // 无冲突时 skip 策略同理：包外那条前置既没被跳过也没被覆盖，边必须留得住
    const withSkip = await run(
      pkg([one('T-2002', { dependencies: [{ depends_on: 'T-1001', type: 'blocks' }] })]),
      { strategy: 'skip' },
    );
    expect(withSkip.dependencies).toEqual({ new: 1 });
    expect(await h.prisma.taskDependency.count()).toBe(2);
  });

  it('字段定义与模板的冲突只看 key / name：overwrite 覆盖、skip 保留、新增一律另发本地 id', async () => {
    async function seedLocalDefs(): Promise<void> {
      await h.prisma.customFieldDef.create({
        data: {
          id: 'local-def',
          key: 'severity',
          label: '旧标签',
          type: 'select',
          required: 0,
          options: '["高"]',
          appliesTo: '["缺陷"]',
          sortOrder: 1,
          enabled: 1,
        },
      });
      await h.prisma.taskTemplate.create({
        data: { id: 'local-tpl', name: '缺陷模板', preset: '{}', sortOrder: 1 },
      });
    }
    await seedLocalDefs();

    const document = pkg([one('T-2001')], {
      custom_field_defs: [
        {
          id: 'remote-def',
          key: 'severity',
          label: '新标签',
          type: 'select',
          required: 1,
          options: ['高', '中'],
          applies_to: ['缺陷'],
          sort_order: 7,
        },
        { id: 'remote-other', key: 'owner', label: '负责人', type: 'text', applies_to: ['需求'] },
      ],
      templates: [{ id: 'remote-tpl', name: '缺陷模板', preset: { priority: 0 }, sort_order: 2 }],
    });

    const kept = await run(document, { strategy: 'skip' });
    expect(kept.conflicts.map((item) => `${item.kind}:${item.id}`).sort()).toEqual([
      'field_def:severity',
      'template:缺陷模板',
    ]);
    expect(kept.field_defs).toEqual({ new: 1, updated: 0, skipped: 1 });
    expect(kept.templates).toEqual({ new: 0, updated: 0, skipped: 1 });
    expect(kept.imported).toEqual({ tasks: ['T-2001'], field_defs: ['owner'], templates: [] });
    expect(await h.prisma.customFieldDef.findUnique({ where: { key: 'severity' } })).toMatchObject({
      id: 'local-def',
      label: '旧标签',
    });
    // 包里带来的远端 id 是另一台机器的 UUID，本地一律重新发号
    const created = await h.prisma.customFieldDef.findUnique({ where: { key: 'owner' } });
    expect(created?.id).not.toBe('remote-other');

    // reassign：key 是任务数据引用的锚点，换号换不出第二个同名键，只能保留本地定义
    const reassigned = await run(
      pkg([one('T-2001', { title: 'reassign 也换不出第二个 owner' })], {
        custom_field_defs: [{ key: 'owner', label: '改不掉的标签', type: 'text', applies_to: ['需求'] }],
      }),
      { strategy: 'reassign' },
    );
    expect(reassigned.conflicts).toEqual([
      {
        kind: 'field_def',
        id: 'owner',
        detail: '本地已有同 key 定义：key 是任务数据引用的锚点，不能重编号，本次保留本地定义',
      },
      { kind: 'task', id: 'T-2001', detail: '本地已存在同 id 任务（status=DONE）' },
    ]);
    expect(await h.prisma.customFieldDef.findUnique({ where: { key: 'owner' } })).toMatchObject({
      label: '负责人',
    });

    await h.reset();
    await seedLocalDefs();
    const overwritten = await run(document, { strategy: 'overwrite' });
    expect(overwritten.field_defs).toEqual({ new: 1, updated: 1, skipped: 0 });
    expect(overwritten.templates).toEqual({ new: 0, updated: 1, skipped: 0 });
    expect(overwritten.imported).toEqual({
      tasks: ['T-2001'],
      field_defs: ['severity', 'owner'],
      templates: ['缺陷模板'],
    });
    const def = await h.prisma.customFieldDef.findUnique({ where: { key: 'severity' } });
    expect(def).toMatchObject({ id: 'local-def', label: '新标签', required: 1, sortOrder: 7 });
    expect(await h.prisma.customFieldDef.count()).toBe(2);
    // 同名模板走 update：不新建第二行，列属性被包里覆盖
    expect(await h.prisma.taskTemplate.count()).toBe(1);
    expect(await h.prisma.taskTemplate.findFirst({})).toMatchObject({
      id: 'local-tpl',
      preset: JSON.stringify({ priority: 0 }),
    });
  });
});

describe('状态归一与依赖落库', () => {
  it('包里的 RUNNING 一律降 READY、Run 置 ABANDONED，租约与 current_run_id 清空', async () => {
    const result = await run(
      pkg([
        one('T-2001', {
          status: 'RUNNING',
          current_run_id: 'R-5001',
          run_count: 1,
          runs: [{ id: 'R-5001', run_number: 1, status: 'RUNNING', progress: 40, progress_msg: '跑了半截' }],
        }),
      ]),
    );

    expect(result.tasks.new).toBe(1);
    const task = await h.prisma.task.findUnique({ where: { id: 'T-2001' } });
    expect(task).toMatchObject({ status: 'READY', currentRunId: null, runCount: 1 });
    expect({ leaseId: task?.leaseId, leaseExpiresAt: task?.leaseExpiresAt, stopReason: task?.stopReason }).toEqual({
      leaseId: null,
      leaseExpiresAt: null,
      stopReason: null,
    });
    expect(await h.prisma.taskRun.findUnique({ where: { id: 'R-5001' } })).toMatchObject({
      status: 'ABANDONED',
      // 状态归一只改状态：进度是历史事实，留着给用户看它跑到哪儿断的
      progress: 40,
      progressMsg: '跑了半截',
    });
  });

  it('成环的依赖边在落库时被丢弃，其余边照常写入', async () => {
    const result = await run(
      pkg([
        one('T-2001', { dependencies: [{ depends_on: 'T-2002', type: 'blocks' }] }),
        one('T-2002', { dependencies: [{ depends_on: 'T-2001', type: 'blocks' }] }),
      ]),
    );

    expect(result.dependencies.new).toBe(1);
    expect(result.dropped_dependencies).toEqual([
      { task_id: 'T-2002', depends_on: 'T-2001', reason: 'cycle_detected' },
    ]);
    const rows = await h.prisma.taskDependency.findMany();
    expect(rows.map((row) => `${row.taskId}→${row.dependsOn}`)).toEqual(['T-2001→T-2002']);
  });

  it('自环与重复边各自只留一条，relates 不参与判环', async () => {
    const result = await run(
      pkg([
        one('T-2001', {
          dependencies: [
            { depends_on: 'T-2001', type: 'blocks' },
            { depends_on: 'T-2002', type: 'relates' },
            { depends_on: 'T-2002', type: 'relates' },
          ],
        }),
        one('T-2002', { dependencies: [{ depends_on: 'T-2001', type: 'relates' }] }),
      ]),
    );

    expect(result.dropped_dependencies).toEqual([
      { task_id: 'T-2001', depends_on: 'T-2001', reason: 'self_reference' },
    ]);
    expect(result.dependencies.new).toBe(2);
    expect(await h.prisma.taskDependency.count()).toBe(2);
  });
});

describe('逐条失败语义（不整体回滚）', () => {
  it('坏条目只进 failed[]，同包其余任务保持已落库', async () => {
    const result = await run(
      pkg([
        one('T-2001'),
        { id: 'T-2002' },
        one('T-2003', { type: '不存在的类型' }),
        one('T-2004', { custom_fields: { nope: 'x' } }),
        one('T-2005', { status: 'NOPE' }),
        one('T-2006'),
      ]),
    );

    // 逐条语义：先收 schema 解不出的（缺必填 / 枚举不合法），再收规划期的语义拒绝，
    // 两类都只影响自己那一条，同包其余任务照常落库。
    expect(result.failed).toEqual([
      { kind: 'task', id: 'T-2002', code: 'VALIDATION_FAILED', detail: expect.any(String) },
      { kind: 'task', id: 'T-2005', code: 'VALIDATION_FAILED', detail: expect.any(String) },
      { kind: 'task', id: 'T-2003', code: 'VALIDATION_FAILED', detail: '任务类型「不存在的类型」不在词表内' },
      { kind: 'task', id: 'T-2004', code: 'VALIDATION_FAILED', detail: '自定义字段「nope」无定义或已停用' },
    ]);
    expect(result.tasks.new).toBe(2);
    expect(result.imported.tasks).toEqual(['T-2001', 'T-2006']);
    expect(await h.prisma.task.findUnique({ where: { id: 'T-2004' } })).toBeNull();
  });

  it('写库阶段才失败的那一条不牵连同包：其余条目仍然落库', async () => {
    const result = await run(pkg([one('T-2001'), one('T-2001', { title: '同号第二条' }), one('T-2002')]));

    expect(result.failed).toEqual([{ kind: 'task', id: 'T-2001', code: 'INTERNAL', detail: expect.any(String) }]);
    expect(await h.prisma.task.count()).toBe(2);
    expect(await h.prisma.task.findUnique({ where: { id: 'T-2002' } })).not.toBeNull();
  });

  it('包内目标任务在写库阶段失败时，指向它的边按 task_failed 丢弃且只报三个键', async () => {
    const result = await run(
      pkg([
        one('T-2001', { runs: [{ id: 'R-9001', started_at: '不是时间' }] }),
        one('T-2002', { dependencies: [{ depends_on: 'T-2001', type: 'blocks' }] }),
      ]),
    );

    expect(result.failed).toEqual([
      { kind: 'task', id: 'T-2001', code: 'INTERNAL', detail: '无法解析的时间：不是时间' },
    ]);
    expect(result.imported.tasks).toEqual(['T-2002']);
    expect(result.dropped_dependencies).toEqual([
      { task_id: 'T-2002', depends_on: 'T-2001', reason: 'task_failed' },
    ]);
    expect(result.dependencies.new).toBe(0);
    expect(await h.prisma.task.findUnique({ where: { id: 'T-2001' } })).toBeNull();
  });

  it('整包级错误都在写库前拒绝：版本过高、非 JSON、结构不符、缺 file、超过 32 MB', async () => {
    const tooNew = (await thrown(run(pkg([one('T-2001')], { version: 99 })))) as ApiException;
    expect(tooNew.code).toBe('VALIDATION_FAILED');
    expect(tooNew.status).toBe(422);
    expect(tooNew.message).toContain('请升级应用');

    const notJson = (await thrown(run(Buffer.from('{ 这不是 JSON')))) as ApiException;
    expect(notJson.toBody().error).toMatchObject({ code: 'VALIDATION_FAILED', details: [{ code: 'invalid_json' }] });

    const wrongShape = (await thrown(run(['不是对象']))) as ApiException;
    expect(wrongShape.status).toBe(422);

    const missingFile = (await thrown(h.imports.run(undefined, importRequest({})))) as ApiException;
    expect(missingFile.toBody().error).toMatchObject({ code: 'VALIDATION_FAILED', details: [{ code: 'missing_file' }] });

    const oversized = (await thrown(run(Buffer.alloc(IMPORT_MAX_BYTES + 1, 0x61)))) as ApiException;
    expect(oversized.toBody().error).toMatchObject({ code: 'VALIDATION_FAILED', details: [{ code: 'too_large' }] });

    expect(await h.prisma.task.count()).toBe(0);
    expect(readdirSync(paths.backupsDir())).toEqual([]);
  });
});

describe('导入前自动备份与审计（6.12.2 / 9.3）', () => {
  it('真有写行时先落一次备份，结果页给出文件名与路径，内容是写入前的快照', async () => {
    await seedTask(h.prisma, 'T-1001', { status: 'DONE', title: '备份里的旧标题' });

    const result = await run(pkg([one('T-1001', { title: '覆盖它' })]), { strategy: 'overwrite' });

    expect(result.backup).not.toBeNull();
    expect(result.backup!.name).toMatch(/^atb-\d{8}-\d{6}\.db$/);
    expect(result.backup!.path).toBe(path.join(paths.backupsDir(), result.backup!.name));
    expect(existsSync(result.backup!.path)).toBe(true);
    expect(readdirSync(paths.backupsDir())).toEqual([result.backup!.name]);

    const probe = new DatabaseSync(result.backup!.path);
    try {
      const row = probe.prepare(`SELECT title FROM tasks WHERE id = 'T-1001'`).get() as { title: string };
      expect(row.title).toBe('备份里的旧标题');
    } finally {
      probe.close();
    }
    expect(await h.prisma.task.findUnique({ where: { id: 'T-1001' } })).toMatchObject({ title: '覆盖它' });
  });

  it('落一条 import 审计：before 里带策略与自动备份的文件名，after 是三类计数', async () => {
    await run(pkg([one('T-2001', { title: '只导任务' })]), { strategy: 'reassign' });

    const audit = await h.prisma.auditLog.findFirst({ where: { action: 'import' }, orderBy: { id: 'desc' } });
    expect(audit).toMatchObject({ actorType: 'user', targetType: 'data', targetId: null });
    const before = JSON.parse(audit?.before ?? '{}');
    expect(before.strategy).toBe('reassign');
    expect(before.backup).toMatch(/^atb-\d{8}-\d{6}\.db$/);
    expect(JSON.parse(audit?.after ?? '{}')).toMatchObject({ tasks: { new: 1 }, conflicts: 0, failed: 0 });
  });
});

describe('导出 → 导入闭环（18 章 26：空实例完整恢复）', () => {
  async function seedInstance(): Promise<unknown> {
    await h.prisma.customFieldDef.create({
      data: {
        id: 'def-1',
        key: 'severity',
        label: '严重度',
        type: 'select',
        required: 1,
        options: JSON.stringify(['高', '中']),
        appliesTo: JSON.stringify(['缺陷']),
        sortOrder: null,
      },
    });
    await h.prisma.taskTemplate.create({
      data: { id: 'tpl-1', name: '缺陷模板', description: null, preset: JSON.stringify({ priority: 0 }), sortOrder: null },
    });
    await seedTask(h.prisma, 'T-1001', { status: 'DONE', priority: 1, tags: JSON.stringify(['核心']) });
    await seedTask(h.prisma, 'T-1002', {
      status: 'REVIEW',
      type: '缺陷',
      customFields: JSON.stringify({ severity: '高' }),
      currentRunId: 'R-2001',
      runCount: 1,
    });
    await seedRun(h.prisma, 'R-2001', 'T-1002', {
      runNumber: 1,
      status: 'SUCCESS',
      output: 'SENTINEL 全文正文不外导',
      error: 'SENTINEL 错误正文',
      durationMs: 5000,
    });
    await h.prisma.review.create({
      data: {
        id: 'rev-1',
        taskId: 'T-1002',
        runId: 'R-2001',
        conclusion: 'APPROVE',
        suggestion: '可以',
        reason: '',
        detail: '',
        returnTo: null,
        priorityAdj: null,
        createdAt: nowSql(),
      },
    });
    await h.prisma.taskDependency.create({
      data: { id: 'dep-1', taskId: 'T-1002', dependsOn: 'T-1001', type: 'blocks', createdAt: nowSql() },
    });
    await h.prisma.artifact.create({
      data: {
        id: 'art-1',
        taskId: 'T-1002',
        runId: 'R-2001',
        type: 'diff',
        uri: 'artifacts/T-1002/R-2001/art-1.diff',
        sizeBytes: 10,
      },
    });
    return (await h.data.export(exportRequest({ scope: 'all', include_archived: true }))).document;
  }

  it('导出包原样导回空实例：任务 / Run / 审核 / 依赖 / 定义 / 模板都回来，一条不失败', async () => {
    const document = await seedInstance();
    await h.reset();

    const result = await run(document);

    expect(result.failed).toEqual([]);
    expect(result.dropped_dependencies).toEqual([]);
    expect(result.conflicts).toEqual([]);
    expect(result.tasks.new).toBe(2);
    expect(result.runs.new).toBe(1);
    expect(result.reviews.new).toBe(1);
    expect(result.dependencies.new).toBe(1);
    expect(result.imported).toEqual({ tasks: ['T-1001', 'T-1002'], field_defs: ['severity'], templates: ['缺陷模板'] });

    expect(await h.prisma.task.findUnique({ where: { id: 'T-1002' } })).toMatchObject({
      status: 'REVIEW',
      type: '缺陷',
      customFields: JSON.stringify({ severity: '高' }),
      currentRunId: 'R-2001',
      runCount: 1,
    });
    expect(await h.prisma.taskDependency.count()).toBe(1);
    expect(await h.prisma.taskTemplate.count()).toBe(1);
    expect(await h.prisma.customFieldDef.count()).toBe(1);
    // 本地新建要接在导入进来的号之后，而不是撞上 T-1002 / R-2001
    expect(await sequence('task')).toBeGreaterThanOrEqual(1002);
    expect(await sequence('run')).toBeGreaterThanOrEqual(2001);
  });

  it('产物与 Run 正文本来就不在包里：导入只留一条告警，不建 artifacts 行', async () => {
    const document = await seedInstance();
    await h.reset();

    const result = await run(document);

    expect(result.warnings).toEqual([
      '1 个任务带产物，但产物文件与日志不随导出迁移（6.12.1），未导入任何 artifacts 行',
    ]);
    expect(await h.prisma.artifact.count()).toBe(0);
    const runRow = await h.prisma.taskRun.findUnique({ where: { id: 'R-2001' } });
    expect({ output: runRow?.output, error: runRow?.error, durationMs: runRow?.durationMs }).toEqual({
      output: null,
      error: null,
      durationMs: 5000,
    });
  });

  it('导出的 sort_order 一律归成数字：NULL 会让自己的导入通道把整条定义判失败', async () => {
    const document = (await seedInstance()) as { templates: { sort_order: unknown }[] };
    expect(document.templates[0]?.sort_order).toBe(0);
  });

  it('空实例导出的空包再导回去，给出合法的空结果而不是报错', async () => {
    const empty = await h.data.export(exportRequest({ scope: 'all' }));
    const result = await run(empty.document);

    expect(result.tasks).toEqual({ new: 0, updated: 0, skipped: 0 });
    expect(result.backup).toBeNull();
    expect(readdirSync(paths.backupsDir())).toEqual([]);
  });
});
