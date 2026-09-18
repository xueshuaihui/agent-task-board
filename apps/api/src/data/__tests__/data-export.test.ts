import { BUILTIN_ACCOUNT_ID } from '../../auth/accounts.service';
import { mkdirSync, readdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { ApiException } from '../../contract/errors';
import { nowSql } from '../../contract/time';
import { paths } from '../../common/paths';
import type { ExportDocument, ExportedTask } from '../data.dto';
import {
  createDataHarness,
  exportRequest,
  seedArtifact,
  seedAudit,
  seedRun,
  seedTask,
  type DataHarness,
} from './temp-db';

/**
 * 6.12.1 导出。三档范围 + 「JSON 不含」的四条（产物文件与日志、audit_logs、api_tokens、
 * Run 的 output/error 正文）是本节的契约价值所在：范围错了会静默少导一批任务，
 * 不含的东西导出去则会带走用户不想迁移的正文与 Token 痕迹。
 */

let h: DataHarness;

beforeAll(() => {
  h = createDataHarness('atb-data-export-');
});

afterEach(async () => {
  await h.reset();
});

afterAll(async () => {
  await h.dispose();
});

async function run(req: unknown): Promise<ExportDocument> {
  return (await h.data.export(exportRequest(req))).document;
}

async function seedBasic(): Promise<void> {
  await seedTask(h.prisma, 'T-1001', { status: 'DONE', type: '缺陷', priority: 1, tags: JSON.stringify(['核心']) });
  await seedTask(h.prisma, 'T-1002', { status: 'READY' });
  await seedTask(h.prisma, 'T-1003', { status: 'DONE', archivedAt: nowSql() });
  await h.prisma.taskDependency.create({
    data: { id: 'dep-1', taskId: 'T-1002', dependsOn: 'T-1001', type: 'blocks', createdAt: nowSql() },
  });
}

function taskOf(document: ExportDocument, id: string): ExportedTask {
  const found = document.tasks.find((task) => task.id === id);
  if (!found) throw new Error(`导出体里没有 ${id}`);
  return found;
}

describe('导出范围（全部 / 当前筛选 / 选中）', () => {
  it('scope=all 默认不含已归档，勾上 include_archived 才带上', async () => {
    await seedBasic();

    const plain = await run({ scope: 'all' });
    expect(plain.scope).toBe('all');
    expect(plain.tasks.map((task) => task.id)).toEqual(['T-1001', 'T-1002']);
    expect(plain.counts.tasks).toBe(2);

    const withArchived = await run({ scope: 'all', include_archived: true });
    expect(withArchived.tasks.map((task) => task.id)).toEqual(['T-1001', 'T-1002', 'T-1003']);
    expect(taskOf(withArchived, 'T-1003').archived_at).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(taskOf(plain, 'T-1001').archived_at).toBeNull();
  });

  it('scope=selected 只带勾选的，归档的那几个同样要显式放行', async () => {
    await seedBasic();

    const selected = await run({ scope: 'selected', ids: ['T-1002', 'T-1003'] });
    expect(selected.tasks.map((task) => task.id)).toEqual(['T-1002']);
    const explicit = await run({ scope: 'selected', ids: ['T-1002', 'T-1003'], include_archived: true });
    expect(explicit.tasks.map((task) => task.id)).toEqual(['T-1002', 'T-1003']);
  });

  it('scope=selected 而 ids 为空 → 422，不静默退化成全量导出', async () => {
    await seedBasic();
    const error = await h.data.export(exportRequest({ scope: 'selected', ids: [] })).catch((e) => e);
    expect(error).toBeInstanceOf(ApiException);
    expect((error as ApiException).code).toBe('VALIDATION_FAILED');
    expect((error as ApiException).status).toBe(422);
  });

  it('scope=filtered 与列表页共用谓词：status / priority / type / keyword 各自命中', async () => {
    await seedBasic();

    expect((await run({ scope: 'filtered', filter: { status: ['DONE'] } })).tasks.map((t) => t.id)).toEqual([
      'T-1001',
    ]);
    // `priority` 在 wire 上是字符串（列表页就是这么发的），DTO 侧 transform 成数字
    expect((await run({ scope: 'filtered', filter: { priority: ['1'] } })).tasks.map((t) => t.id)).toEqual(['T-1001']);
    expect((await run({ scope: 'filtered', filter: { type: ['缺陷'] } })).tasks.map((t) => t.id)).toEqual(['T-1001']);
    // keyword 命中标题、描述与 id 三处
    expect((await run({ scope: 'filtered', filter: { keyword: 'T-100' } })).tasks).toHaveLength(2);
    await h.prisma.task.update({ where: { id: 'T-1002' }, data: { description: '含 关键短语 的描述' } });
    expect((await run({ scope: 'filtered', filter: { keyword: '关键短语' } })).tasks.map((t) => t.id)).toEqual([
      'T-1002',
    ]);
    expect((await run({ scope: 'filtered', filter: { keyword: '不存在' } })).tasks).toEqual([]);
  });

  it('scope=filtered 的 tags 与 custom_fields 走同一份 json_each 谓词（20.3 / 20.10）', async () => {
    await seedTask(h.prisma, 'T-1001', { tags: JSON.stringify(['核心', '回归']) });
    await seedTask(h.prisma, 'T-1002', { tags: JSON.stringify(['其他']) });
    await h.prisma.customFieldDef.create({
      data: {
        id: 'def-1',
        key: 'severity',
        label: '严重度',
        type: 'select',
        required: 0,
        options: JSON.stringify(['高', '中', '低']),
        appliesTo: JSON.stringify(['缺陷']),
        enabled: 1,
      },
    });
    await seedTask(h.prisma, 'T-1003', { type: '缺陷', customFields: JSON.stringify({ severity: '高' }) });

    // 多标签之间是 OR
    expect((await run({ scope: 'filtered', filter: { tags: ['回归', '其他'] } })).tasks.map((t) => t.id)).toEqual([
      'T-1001',
      'T-1002',
    ]);
    expect(
      (await run({ scope: 'filtered', filter: { custom_fields: { severity: ['高'] } } })).tasks.map((t) => t.id),
    ).toEqual(['T-1003']);
    // 与其余条件求交
    expect(
      (await run({ scope: 'filtered', filter: { status: ['READY'], tags: ['核心'] } })).tasks.map((t) => t.id),
    ).toEqual(['T-1001']);
    // 筛不出任何任务时给出空集，而不是忽略该条件
    expect(
      (await run({ scope: 'filtered', filter: { custom_fields: { severity: ['低'] } } })).tasks,
    ).toEqual([]);
  });

  it('依赖边只带走两端都在导出集里的那些', async () => {
    await seedBasic();

    const full = await run({ scope: 'all' });
    expect(taskOf(full, 'T-1002').dependencies).toEqual([{ depends_on: 'T-1001', type: 'blocks' }]);
    // 只导下游：这条边指向集外，带走也只会变成悬空引用
    expect(taskOf(await run({ scope: 'selected', ids: ['T-1002'] }), 'T-1002').dependencies).toEqual([]);
  });
});

describe('导出内容（6.12.1 的「含」与「不含」）', () => {
  /** 一条带 Run、审核、产物、日志正文与审计的任务。 */
  async function seedEverything(): Promise<void> {
    await seedTask(h.prisma, 'T-1001', { status: 'DONE', runCount: 1, currentRunId: 'R-1001' });
    await seedRun(h.prisma, 'R-1001', 'T-1001', {
      status: 'SUCCESS',
      output: 'SENTINEL-run-output 全文 12 万字',
      error: 'SENTINEL-run-error',
      summary: '改完 3 个文件',
      durationMs: 4200,
      progress: 100,
      leaseId: 'lease-1',
      tokenId: null,
    });
    await seedArtifact(h.prisma, 'T-1001', 'R-1001', 'artifacts/T-1001/R-1001/sentinel-artifact-uri.diff');
    const artifactFile = path.resolve(paths.dataDir(), 'artifacts/T-1001/R-1001/sentinel-artifact-uri.diff');
    mkdirSync(path.dirname(artifactFile), { recursive: true });
    writeFileSync(artifactFile, 'SENTINEL-artifact-bytes');
    await h.prisma.review.create({
      data: {
        id: 'rev-1',
        taskId: 'T-1001',
        runId: 'R-1001',
        conclusion: 'APPROVE',
        suggestion: '可以',
        reason: '',
        detail: '',
        returnTo: null,
        priorityAdj: null,
        createdAt: nowSql(),
      },
    });
    await h.prisma.comment.create({
      data: { id: 'c-1', taskId: 'T-1001', runId: 'R-1001', authorType: 'agent', content: '日志正文 SENTINEL-log', type: 'log' },
    });
    await h.prisma.apiToken.create({
      data: { id: 'tok-1', name: 'claude-code', tokenHash: 'SENTINEL-token-hash', capabilities: '[]' },
    });
    await seedAudit(h.prisma, 'run_writeback', { note: 'SENTINEL-audit' });
  }

  it('不含产物文件与日志：artifacts 表与 comments 表都不进包，只留缺失标记', async () => {
    await seedEverything();
    const document = await run({ scope: 'all' });
    const text = JSON.stringify(document);

    expect(text).not.toContain('sentinel-artifact-uri');
    expect(text).not.toContain('SENTINEL-artifact-bytes');
    expect(text).not.toContain('SENTINEL-log');
    expect(text).toContain('"artifacts_missing":true');
    expect(Object.keys(taskOf(document, 'T-1001')).sort()).not.toContain('artifacts');
    // counts 里没有产物一项：导出压根不碰 artifacts 表
    expect(document.counts).toEqual({ tasks: 1, field_defs: 0, templates: 0, runs: 1 });
  });

  it('不含审计记录与 api_tokens', async () => {
    await seedEverything();
    const text = JSON.stringify(await run({ scope: 'all' }));
    expect(text).not.toContain('SENTINEL-audit');
    expect(text).not.toContain('SENTINEL-token-hash');
    expect(text).not.toContain('audit');
    expect(text).not.toContain('token_hash');
    expect(await h.prisma.auditLog.count()).toBeGreaterThan(0);
  });

  it('Run 只保留状态与时长：output / error 正文与租约列都不进包', async () => {
    await seedEverything();
    const document = await run({ scope: 'all' });
    const runs = taskOf(document, 'T-1001').runs;

    expect(runs).toHaveLength(1);
    expect(runs[0]).toMatchObject({
      id: 'R-1001',
      run_number: 1,
      status: 'SUCCESS',
      duration_ms: 4200,
      summary: '改完 3 个文件',
    });
    expect(Object.keys(runs[0] as object).sort()).toEqual([
      'agent_name',
      'duration_ms',
      'finished_at',
      'id',
      'progress',
      'progress_msg',
      'run_number',
      'started_at',
      'status',
      'summary',
      'trigger_type',
    ]);
    const text = JSON.stringify(runs);
    expect(text).not.toContain('SENTINEL-run-output');
    expect(text).not.toContain('SENTINEL-run-error');
    expect(text).not.toContain('lease');
    expect(text).not.toContain('token_id');
  });

  it('带字段定义与模板：换机后 custom_fields 才有处校验（20.10）', async () => {
    await h.prisma.customFieldDef.create({
      data: {
        id: 'def-1',
        key: 'severity',
        label: '严重度',
        type: 'select',
        required: 1,
        options: JSON.stringify(['高', '中', '低']),
        appliesTo: JSON.stringify(['缺陷']),
        showOnCard: 1,
        sortOrder: 2,
      },
    });
    await h.prisma.taskTemplate.create({
      data: { id: 'tpl-1', name: '缺陷模板', description: null, preset: JSON.stringify({ priority: 0 }), sortOrder: 1 },
    });
    await seedTask(h.prisma, 'T-1001', { type: '缺陷', customFields: JSON.stringify({ severity: '高' }) });

    const document = await run({ scope: 'all' });
    expect(document.custom_field_defs).toEqual([
      {
        key: 'severity',
        label: '严重度',
        type: 'select',
        required: 1,
        default_value: null,
        options: ['高', '中', '低'],
        applies_to: ['缺陷'],
        show_on_card: 1,
        sort_order: 2,
        enabled: 1,
      },
    ]);
    expect(document.templates).toEqual([
      { name: '缺陷模板', description: null, preset: { priority: 0 }, sort_order: 1 },
    ]);
    expect(taskOf(document, 'T-1001').custom_fields).toEqual({ severity: '高' });
    expect(document.counts).toEqual({ tasks: 1, field_defs: 1, templates: 1, runs: 0 });
    expect(Object.keys(document)).toEqual([
      'version',
      'app_version',
      'exported_at',
      'scope',
      'counts',
      'custom_field_defs',
      'templates',
      'tasks',
    ]);
    expect(document.version).toBe(2);
  });

  it('任务侧字段齐全：标签/置顶/archived_at/能力集都带得上，时间是 ISO 串', async () => {
    await seedTask(h.prisma, 'T-1001', {
      title: '带齐字段',
      description: '描述',
      status: 'REVIEW',
      priority: 0,
      tags: JSON.stringify(['核心']),
      requiredCapabilities: JSON.stringify(['tool:git']),
      pinned: 1,
      dueAt: '2026-10-01',
      createdAt: '2026-09-01 08:00:00',
      updatedAt: '2026-09-02 09:30:00',
    });
    const task = taskOf(await run({ scope: 'all' }), 'T-1001');

    expect(task).toMatchObject({
      id: 'T-1001',
      title: '带齐字段',
      description: '描述',
      status: 'REVIEW',
      priority: 0,
      tags: ['核心'],
      required_capabilities: ['tool:git'],
      pinned: true,
      due_at: '2026-10-01',
      created_at: '2026-09-01T08:00:00Z',
      updated_at: '2026-09-02T09:30:00Z',
      run_count: 0,
      current_run_id: null,
    });
  });

  it('脏 JSON 列不带崩整包：解析不回来的原文只留摘要', async () => {
    await seedTask(h.prisma, 'T-1001', { tags: '不是 JSON' });
    await h.prisma.taskTemplate.create({
      data: { id: 'tpl-1', name: '坏模板', preset: '{ 这不是 JSON', sortOrder: null },
    });

    const document = await run({ scope: 'all' });
    expect(taskOf(document, 'T-1001').tags).toEqual([]);
    expect(document.templates[0]?.preset).toEqual({ unparsable: '{ 这不是 JSON' });
    // 可空列出包时归 0：导入侧只收数字，NULL 会让这条模板连同引用一起判失败
    expect(document.templates[0]?.sort_order).toBe(0);
  });

  it('导出文件名是 atb-export-YYYYMMDD-HHmmss.json，并落一条 export 审计', async () => {
    await seedBasic();
    const { filename, document } = await h.data.export(
      exportRequest({ scope: 'filtered', filter: { status: ['DONE'] } }),
      { kind: 'ui', accountId: BUILTIN_ACCOUNT_ID, username: 'test', role: 'ADMIN', mustChangePassword: false },
    );

    expect(filename).toMatch(/^atb-export-\d{8}-\d{6}\.json$/);
    expect(document.scope).toBe('filtered');
    const audit = await h.prisma.auditLog.findFirst({ where: { action: 'export' }, orderBy: { id: 'desc' } });
    expect(audit?.targetType).toBe('data');
    expect(JSON.parse(audit?.after ?? '{}')).toEqual({
      scope: 'filtered',
      include_archived: false,
      counts: document.counts,
    });
  });

  it('空实例导出一份合法的空包，而不是报错', async () => {
    const document = await run({ scope: 'all' });
    expect(document.tasks).toEqual([]);
    expect(document.counts).toEqual({ tasks: 0, field_defs: 0, templates: 0, runs: 0 });
  });

  it('产物目录本身不在导出里（导出只读库，不枚举磁盘）', async () => {
    await seedEverything();
    const before = readdirSync(paths.artifactsDir(), { recursive: true });
    await run({ scope: 'all', include_archived: true });
    expect(readdirSync(paths.artifactsDir(), { recursive: true })).toEqual(before);
  });
});
