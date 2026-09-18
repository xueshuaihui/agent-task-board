import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import type { RequestAuth } from '../auth/auth.scope';
import { BUILTIN_ACCOUNT_ID } from '../auth/accounts.service';
import { ApiException } from '../contract/errors';
import type { CustomFieldFilter } from '../contract/schemas';
import { toIso } from '../contract/time';
import { jsonFilterParts } from '../tasks/json-filters';
import { parseJsonArray, parseJsonObject } from '../tasks/task.dto';
import { appVersion } from '../common/version';
import { exportNameAt } from '../backup/backup-name';
import { AuditService } from '../infra/audit.service';
import { PrismaService } from '../infra/prisma.service';
import {
  EXPORT_FORMAT_VERSION,
  type ExportDocument,
  type ExportRequest,
  type ExportedFieldDef,
  type ExportedReview,
  type ExportedRun,
  type ExportedTask,
  type ExportedTemplate,
} from './data.dto';

/** Prisma 的 `IN` 会展开成同样多的绑定参数，SQLite 有变量上限，一次最多带这么多 id。 */
const IN_CHUNK = 400;

export interface ExportResult {
  filename: string;
  document: ExportDocument;
}

/**
 * 6.12.1 导出：任务 + 字段定义 + 模板三块，Run 只留状态与时长。
 * 「按任务 → 字段定义 → 模板顺序生成」是硬要求，导入侧反序先建定义（20.10 会校验键名）。
 */
@Injectable()
export class DataService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  async export(req: ExportRequest, auth?: RequestAuth): Promise<ExportResult> {
    // 0919：导出按账号隔离；无凭证调用（仅测试/内部）回落内置账号。
    const accountId = auth?.accountId ?? BUILTIN_ACCOUNT_ID;
    const ids = await this.selectTaskIds(req, accountId);
    const tasks = ids.length ? await this.loadTasks(ids, accountId) : [];
    const kept = tasks.map((task) => task.id);

    const dependencies = await this.loadDependencies(kept);
    const runs = await this.loadRuns(kept);
    const reviews = await this.loadReviews(kept);
    const withArtifacts = await this.loadArtifactFlags(kept);
    const fieldDefs = await this.loadFieldDefs(accountId);
    const templates = await this.loadTemplates(accountId);

    const document: ExportDocument = {
      version: EXPORT_FORMAT_VERSION,
      app_version: appVersion,
      exported_at: new Date().toISOString(),
      scope: req.scope,
      counts: {
        tasks: tasks.length,
        field_defs: fieldDefs.length,
        templates: templates.length,
        runs: runs.size,
      },
      custom_field_defs: fieldDefs,
      templates,
      tasks: tasks.map((task) => ({
        ...task,
        dependencies: dependencies.get(task.id) ?? [],
        runs: runs.get(task.id) ?? [],
        reviews: reviews.get(task.id) ?? [],
        ...(withArtifacts.has(task.id) ? { artifacts_missing: true as const } : {}),
      })),
    };

    await this.audit.record({
      actorType: 'user',
      actorName: authName(auth),
      action: 'export',
      targetType: 'data',
      after: {
        scope: req.scope,
        include_archived: req.include_archived,
        counts: document.counts,
      },
    });
    return { filename: exportNameAt(), document };
  }

  // ---------------------------------------------------------------- 范围解析

  /**
   * 三种 scope 共用一份筛选实现（20.7）：`filtered` 直接复用列表页的谓词构造，
   * `selected` 也过一遍归档规则，否则「勾选 3 个 + 不含归档」会悄悄导出已归档的那几个。
   */
  private async selectTaskIds(req: ExportRequest, accountId: string): Promise<string[]> {
    const where: Prisma.TaskWhereInput = { accountId, ...(req.include_archived ? {} : { archivedAt: null }) };

    if (req.scope === 'selected') {
      if (!req.ids?.length) {
        throw new ApiException('VALIDATION_FAILED', 'scope=selected 需要至少一个任务 id', [
          { path: 'ids', code: 'missing_ids', message: '为空时请用 scope=all' },
        ]);
      }
      where.id = { in: req.ids };
      const rows = await this.prisma.task.findMany({ where, select: { id: true } });
      return rows.map((row) => row.id);
    }

    if (req.scope === 'filtered') {
      const filter = req.filter ?? {};
      if (filter.status?.length) where.status = { in: filter.status };
      if (filter.priority?.length) where.priority = { in: filter.priority };
      if (filter.type?.length) where.type = { in: filter.type };
      if (filter.keyword) {
        where.OR = [
          { title: { contains: filter.keyword } },
          { description: { contains: filter.keyword } },
          { id: { contains: filter.keyword } },
        ];
      }
      const candidates = await this.idsByJsonFilters(filter.tags, filter.custom_fields, accountId);
      if (candidates) {
        where.id = candidates.length ? { in: candidates } : { in: ['__none__'] };
      }
    }

    const rows = await this.prisma.task.findMany({
      where,
      select: { id: true },
      orderBy: { createdAt: 'asc' },
    });
    return rows.map((row) => row.id);
  }

  /** 与列表页同一份 `json_each` 谓词：先取候选 id 再求交，谓词里的别名固定 `t`。 */
  private async idsByJsonFilters(
    tags: string[] | undefined,
    customFields: CustomFieldFilter | undefined,
    accountId: string,
  ): Promise<string[] | null> {
    const parts = jsonFilterParts(tags, customFields);
    if (parts.length === 0) return null;
    const rows = await this.prisma.$queryRaw<{ id: string }[]>`
      SELECT t.id FROM tasks t
      WHERE t.account_id = ${accountId} AND ${Prisma.join(parts, ' AND ')}`;
    return rows.map((row) => row.id);
  }

  // ---------------------------------------------------------------- 分块读取

  private async loadTasks(ids: string[], accountId: string): Promise<Omit<ExportedTask, 'dependencies' | 'runs' | 'reviews'>[]> {
    const rows = await gather(ids, async (part) =>
      this.prisma.task.findMany({
        where: { id: { in: part }, accountId },
        orderBy: { createdAt: 'asc' },
      }),
    );
    return rows.map((row) => ({
      id: row.id,
      type: row.type,
      title: row.title,
      description: row.description,
      status: row.status,
      priority: row.priority,
      tags: parseJsonArray(row.tags),
      required_capabilities: parseJsonArray(row.requiredCapabilities),
      custom_fields: parseJsonObject(row.customFields),
      pinned: row.pinned === 1,
      due_at: toIso(row.dueAt),
      archived_at: toIso(row.archivedAt),
      created_at: toIso(row.createdAt),
      updated_at: toIso(row.updatedAt),
      run_count: row.runCount,
      current_run_id: row.currentRunId,
    }));
  }

  /** 两端都在导出集里才带走：否则导入侧必然把它当悬空边丢掉，不如不导。 */
  private async loadDependencies(
    ids: string[],
  ): Promise<Map<string, { depends_on: string; type: string }[]>> {
    const kept = new Set(ids);
    const rows = await gather(ids, async (part) =>
      this.prisma.taskDependency.findMany({ where: { taskId: { in: part } } }),
    );
    const map = new Map<string, { depends_on: string; type: string }[]>();
    for (const row of rows) {
      if (!kept.has(row.dependsOn)) continue;
      push(map, row.taskId, { depends_on: row.dependsOn, type: row.type });
    }
    return map;
  }

  /** 6.12.1：`output` / `error` 正文不导出，只留状态与时长。 */
  private async loadRuns(ids: string[]): Promise<Map<string, ExportedRun[]>> {
    const rows = await gather(ids, async (part) =>
      this.prisma.taskRun.findMany({
        where: { taskId: { in: part } },
        orderBy: { runNumber: 'asc' },
        select: {
          id: true,
          taskId: true,
          runNumber: true,
          status: true,
          triggerType: true,
          agentName: true,
          startedAt: true,
          finishedAt: true,
          durationMs: true,
          summary: true,
          progress: true,
          progressMsg: true,
        },
      }),
    );
    const map = new Map<string, ExportedRun[]>();
    for (const row of rows) {
      push(map, row.taskId, {
        id: row.id,
        run_number: row.runNumber,
        status: row.status,
        trigger_type: row.triggerType,
        agent_name: row.agentName,
        started_at: toIso(row.startedAt),
        finished_at: toIso(row.finishedAt),
        duration_ms: row.durationMs,
        summary: row.summary,
        progress: row.progress,
        progress_msg: row.progressMsg,
      });
    }
    return map;
  }

  private async loadReviews(ids: string[]): Promise<Map<string, ExportedReview[]>> {
    const rows = await gather(ids, async (part) =>
      this.prisma.review.findMany({ where: { taskId: { in: part } }, orderBy: { createdAt: 'asc' } }),
    );
    const map = new Map<string, ExportedReview[]>();
    for (const row of rows) {
      push(map, row.taskId, {
        run_id: row.runId,
        conclusion: row.conclusion,
        suggestion: row.suggestion,
        reason: row.reason,
        detail: row.detail,
        return_to: row.returnTo,
        priority_adj: row.priorityAdj,
        created_at: toIso(row.createdAt),
      });
    }
    return map;
  }

  private async loadArtifactFlags(ids: string[]): Promise<Set<string>> {
    const rows = await gather(ids, async (part) =>
      this.prisma.artifact.findMany({ where: { taskId: { in: part } }, select: { taskId: true } }),
    );
    return new Set(rows.map((row) => row.taskId));
  }

  private async loadFieldDefs(accountId: string): Promise<ExportedFieldDef[]> {
    const rows = await this.prisma.customFieldDef.findMany({ where: { accountId }, orderBy: { sortOrder: 'asc' } });
    return rows.map((row) => ({
      key: row.key,
      label: row.label,
      type: row.type,
      required: row.required,
      default_value: row.defaultValue,
      options: row.options === null ? null : safeJson(row.options),
      applies_to: parseJsonArray(row.appliesTo),
      show_on_card: row.showOnCard,
      // 列可空，但导入侧的 `sort_order` 只收数字：NULL 会让这条定义连同所有用到该键的任务一起被判失败，
      // 所以出包时按其余序列化口（`field-defs.service.ts`）同一口径归成 0。
      sort_order: row.sortOrder ?? 0,
      enabled: row.enabled,
    }));
  }

  private async loadTemplates(accountId: string): Promise<ExportedTemplate[]> {
    const rows = await this.prisma.taskTemplate.findMany({ where: { accountId }, orderBy: { createdAt: 'asc' } });
    return rows.map((row) => ({
      name: row.name,
      description: row.description,
      preset: safeJson(row.preset),
      sort_order: row.sortOrder ?? 0,
    }));
  }
}

/** `IN (?)` 绑定参数会随 id 数线性增长，超过 SQLite 变量上限会直接报错，所以分块取。 */
async function gather<T, R>(
  items: T[],
  fn: (part: T[]) => Promise<R[]>,
  size = IN_CHUNK,
): Promise<R[]> {
  const out: R[] = [];
  for (let index = 0; index < items.length; index += size) {
    out.push(...(await fn(items.slice(index, index + size))));
  }
  return out;
}

function push<K, V>(map: Map<K, V[]>, key: K, value: V): void {
  const list = map.get(key);
  if (list) list.push(value);
  else map.set(key, [value]);
}

/** 列里存的是文本 JSON，脏数据不能带崩整包导出。 */
function safeJson(raw: string): unknown {
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    return { unparsable: raw.slice(0, 200) };
  }
}

function authName(auth: RequestAuth | undefined): string {
  return auth?.kind === 'agent' ? auth.tokenName : '我';
}
