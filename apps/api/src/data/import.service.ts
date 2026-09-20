import { Injectable } from '@nestjs/common';
import { ApiException } from '../contract/errors';
import {
  appliesToType,
  normalizeMultiSelect,
  validateFieldValue,
  type FieldDefLike,
  type FieldOptions,
} from '../contract/custom-fields';
import { toDateOnly, nowSql, toSqlTime } from '../contract/time';
import { newId } from '../contract/ids';
import type { RequestAuth } from '../auth/auth.scope';
import type { FieldType } from '../contract/enums';
import { parseJsonArray } from '../tasks/task.dto';
import { AppLogger } from '../infra/logger';
import { AuditService } from '../infra/audit.service';
import { PrismaService } from '../infra/prisma.service';
import { SettingsService } from '../infra/settings.service';
import { BackupService } from '../backup/backup.service';
import {
  EXPORT_FORMAT_VERSION,
  importedFieldDefSchema,
  importedTaskSchema,
  importedTemplateSchema,
  importPayloadSchema,
  type ImportedFieldDef,
  type ImportedReview,
  type ImportedRun,
  type ImportedTask,
  type ImportedTemplate,
  type ImportRequest,
  type ImportStrategy,
} from './data.dto';

/** 单包上限：导出侧不分页，导入侧至少要挡住误传进来的大文件。 */
const MAX_ITEMS = 5000;

/** 一次 `IN` 的绑定参数上限（与 6.12.1 导出侧同一档位）。 */
const TASK_IN_CHUNK = 400;

/** 导入文件收进内存，所以给一个硬顶；multer 侧留更高一档，让这里先给出人话错误。 */
export const IMPORT_MAX_BYTES = 32 * 1024 * 1024;

export interface ImportCounters {
  new: number;
  updated: number;
  skipped: number;
}

export interface ImportConflict {
  kind: 'task' | 'field_def' | 'template';
  id: string;
  detail: string;
}

export interface ImportSkipped {
  kind: 'task' | 'field_def' | 'template';
  id: string;
  reason: string;
}

export interface ImportFailure {
  kind: 'task' | 'field_def' | 'template';
  id: string | null;
  code: string;
  detail: string;
}

export interface DroppedEdge {
  task_id: string;
  depends_on: string;
  reason: string;
}

export interface ImportResult {
  dry_run: boolean;
  strategy: ImportStrategy | null;
  /** 6.12.2：真正导入前会先做一次手动备份，结果页给出路径；预览不备份所以是 null。 */
  backup: { name: string; path: string } | null;
  tasks: ImportCounters;
  field_defs: ImportCounters;
  templates: ImportCounters;
  runs: { new: number };
  reviews: { new: number };
  dependencies: { new: number };
  conflicts: ImportConflict[];
  imported: { tasks: string[]; field_defs: string[]; templates: string[] };
  skipped: ImportSkipped[];
  failed: ImportFailure[];
  dropped_dependencies: DroppedEdge[];
  /** reassign 的对账表：文件里的号 → 计划落库的号。 */
  id_map: { tasks: Record<string, string>; runs: Record<string, string> };
  warnings: string[];
}

type Action = 'create' | 'update' | 'skip';

interface RunPlan {
  originalId: string | null;
  finalId: string;
  runNumber: number;
  normalized: boolean;
  run: ImportedRun;
}

interface ReviewPlan {
  review: ImportedReview;
  runId: string | null;
}

interface TaskPlan {
  originalId: string | null;
  finalId: string;
  action: Action;
  task: ImportedTask;
  runs: RunPlan[];
  reviews: ReviewPlan[];
  currentRun: RunPlan | null;
  /** 文件里是 RUNNING，落库前要降成 READY（6.12.2 状态归一）。 */
  normalized: boolean;
}

interface Plan {
  tasks: TaskPlan[];
  fieldDefs: { action: Action; def: ImportedFieldDef }[];
  templates: { action: Action; tpl: ImportedTemplate }[];
  edges: { task_id: string; depends_on: string; type: string; target_local: boolean }[];
  dropped: DroppedEdge[];
  conflicts: ImportConflict[];
  skipped: ImportSkipped[];
  failed: ImportFailure[];
  warnings: string[];
  taskCursor: number;
  runCursor: number;
  keptTaskMax: number;
  keptRunMax: number;
}

/**
 * 6.12.2 导入：规划与落库两段分开。`plan()` 全程只读，`dry_run` 走完它就返回——
 * 「预览不写库」由结构保证，而不是靠落库分支里到处补 `if (dryRun)`。
 */
@Injectable()
export class ImportService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly settings: SettingsService,
    private readonly backups: BackupService,
    private readonly audit: AuditService,
    private readonly logger: AppLogger,
  ) {}

  async run(
    file: { buffer?: Buffer; originalname?: string } | undefined,
    req: ImportRequest,
    auth?: RequestAuth,
  ): Promise<ImportResult> {
    if (!file?.buffer?.length) {
      throw new ApiException('VALIDATION_FAILED', '缺少 file 字段（multipart 单文件）', [
        { path: 'file', code: 'missing_file', message: '需要一个 JSON 导出文件' },
      ]);
    }
    if (file.buffer.length > IMPORT_MAX_BYTES) {
      throw new ApiException('VALIDATION_FAILED', `导入文件超过 ${Math.round(IMPORT_MAX_BYTES / 1024 / 1024)} MB`, [
        { path: 'file', code: 'too_large', message: '请缩小导出范围后重试' },
      ]);
    }
    const plan = await this.plan(decode(file.buffer), req);
    if (req.dry_run) return summarize(plan, req, null);

    if (plan.conflicts.length && !req.strategy) {
      throw new ApiException('IMPORT_ID_CONFLICT', `存在 ${plan.conflicts.length} 处 ID 冲突，必须选择处理策略`, {
        conflicts: plan.conflicts.slice(0, 50),
      });
    }

    // 6.12.2：导入不可逆，先落一个手动备份；预览或未写任何行时不制造空备份。
    const hasWork = [
      ...plan.tasks,
      ...plan.fieldDefs,
      ...plan.templates,
    ].some((item) => item.action !== 'skip');
    const backup = hasWork ? await this.backups.create('导入前自动备份') : null;

    await this.bumpSequences(plan);
    const written = await this.apply(plan);

    const result = summarize(plan, req, backup ? { name: backup.name, path: backup.path } : null);
    result.runs.new = written.runs;
    result.reviews.new = written.reviews;
    result.dependencies.new = written.edges;
    // 逐条语义（6.12.2）：写失败的那一条从 new/updated 里退回来，其余条目保持已落库的结果。
    const failedIds = new Set(written.failed.map((item) => item.id));
    for (const failure of written.failed) result.failed.push(failure);

    const tasksOk = plan.tasks.filter((item) => item.action !== 'skip' && !failedIds.has(item.finalId));
    result.tasks.new = tasksOk.filter((item) => item.action === 'create').length;
    result.tasks.updated = tasksOk.filter((item) => item.action === 'update').length;
    result.imported.tasks = tasksOk.map((item) => item.finalId);

    const defsOk = plan.fieldDefs.filter((item) => item.action !== 'skip' && !failedIds.has(item.def.key));
    result.field_defs.new = defsOk.filter((item) => item.action === 'create').length;
    result.field_defs.updated = defsOk.filter((item) => item.action === 'update').length;
    result.imported.field_defs = defsOk.map((item) => item.def.key);

    const templatesOk = plan.templates.filter((item) => item.action !== 'skip' && !failedIds.has(item.tpl.name));
    result.templates.new = templatesOk.filter((item) => item.action === 'create').length;
    result.templates.updated = templatesOk.filter((item) => item.action === 'update').length;
    result.imported.templates = templatesOk.map((item) => item.tpl.name);

    this.logger.log(
      `导入（策略 ${req.strategy ?? '未指定'}）：任务 新增 ${result.tasks.new} / 覆盖 ${result.tasks.updated}` +
        ` / 跳过 ${result.skipped.length} / 失败 ${result.failed.length}`,
      'data',
    );
    await this.audit.record({
      actorType: 'user',
      actorName: auth?.kind === 'agent' ? auth.tokenName : '我',
      action: 'import',
      targetType: 'data',
      before: { strategy: req.strategy ?? null, backup: backup?.name ?? null },
      after: {
        tasks: result.tasks,
        field_defs: result.field_defs,
        templates: result.templates,
        conflicts: result.conflicts.length,
        dropped_dependencies: result.dropped_dependencies.length,
        failed: result.failed.length,
      },
    });
    return result;
  }

  // ---------------------------------------------------------------- 规划（只读）

  private async plan(payload: Payload, req: ImportRequest): Promise<Plan> {
    const plan: Plan = {
      tasks: [],
      fieldDefs: [],
      templates: [],
      edges: [],
      dropped: [],
      conflicts: [],
      skipped: [],
      failed: [],
      warnings: [],
      taskCursor: 0,
      runCursor: 0,
      keptTaskMax: 0,
      keptRunMax: 0,
    };

    const declared = payload.version ?? 1;
    if (declared > EXPORT_FORMAT_VERSION) {
      throw new ApiException(
        'VALIDATION_FAILED',
        `导出文件版本 v${declared} 高于本应用支持的 v${EXPORT_FORMAT_VERSION}，请升级应用`,
        [{ path: 'version', code: 'unsupported_version', message: `支持 v1–v${EXPORT_FORMAT_VERSION}` }],
      );
    }

    const tasks = collect(payload.tasks, importedTaskSchema, 'task', plan);
    const defs = collect(payload.fieldDefs, importedFieldDefSchema, 'field_def', plan);
    const templates = collect(payload.templates, importedTemplateSchema, 'template', plan);

    const sequences = await this.sequences();
    plan.taskCursor = sequences.task;
    plan.runCursor = sequences.run;

    const types = await this.settings.get('task_types');
    const defsByKey = await this.planFieldDefs(defs, req.strategy, plan);
    await this.planTemplates(templates, req.strategy, plan);

    // 依赖边的目标也要查：指向「包里没声明、本地已存在」的前置才是 6.12.2 说的真实存在号位，
    // 只按包内声明的 id 查会让这条边在规划期就被当成缺失目标丢掉。
    const lookups = new Set<string>(tasks.map((task) => task.id).filter((id): id is string => !!id));
    for (const task of tasks) for (const edge of task.dependencies) lookups.add(edge.depends_on);
    const existingTasks = await this.existingTasks([...lookups]);
    const existingRuns = await this.existingRuns(
      tasks.flatMap((task) => task.runs.map((run) => run.id).filter((id): id is string => !!id)),
    );
    // 「冲突为零时不重编号」——只要有一处号位撞车，整包换号，避免一半沿用一半新编。
    const renumber = req.strategy === 'reassign' && tasks.some((task) => task.id && existingTasks.has(task.id));

    const localRunMax = await this.localRunNumbers(
      tasks.filter((task) => task.id && existingTasks.has(task.id)).map((task) => task.id as string),
    );

    let artifacts = 0;
    for (const task of tasks) {
      const local = task.id ? existingTasks.get(task.id) : undefined;
      let action: Action = 'create';
      let reason: string | undefined;
      if (local) {
        plan.conflicts.push({ kind: 'task', id: task.id!, detail: `本地已存在同 id 任务（status=${local.status}）` });
        if (!req.strategy) {
          action = 'skip';
          reason = 'needs_strategy';
        } else if (req.strategy === 'skip') {
          action = 'skip';
          reason = 'id_conflict';
        } else if (req.strategy === 'overwrite') {
          // 6.12.2：覆盖执行中的任务会把正在回写的 Run 一起改掉，一律拒绝。
          if (local.status === 'RUNNING') {
            action = 'skip';
            reason = 'TASK_RUNNING';
          } else {
            action = 'update';
          }
        } else {
          action = 'create';
        }
      }

      if (action === 'skip') {
        plan.skipped.push({ kind: 'task', id: task.id!, reason: reason! });
        // 被跳过的任务仍然占住号位：指向它的依赖边要按「被跳过」报出来，而不是当成不存在。
        plan.tasks.push({
          originalId: task.id ?? null,
          finalId: task.id!,
          action,
          task,
          runs: [],
          reviews: [],
          currentRun: null,
          normalized: false,
        });
        continue;
      }

      const issues = checkTask(task, types, defsByKey);
      if (issues.length) {
        plan.failed.push({ kind: 'task', id: task.id ?? null, code: 'VALIDATION_FAILED', detail: issues.join('；') });
        continue;
      }

      const customFields: Record<string, unknown> = {};
      for (const [key, value] of Object.entries(task.custom_fields)) {
        const def = defsByKey.get(key);
        if (!def) continue;
        customFields[key] = def.type === 'multiselect' ? normalizeMultiSelect(value) : value;
      }

      const keepId = action === 'update' || (!!task.id && !renumber && !local);
      const finalId = keepId ? task.id! : `T-${(plan.taskCursor += 1)}`;
      if (keepId && action === 'create') {
        plan.keptTaskMax = Math.max(plan.keptTaskMax, numericSuffix(finalId, 'T-') ?? 0);
      }
      const runs = this.planRuns(task, action, localRunMax.get(finalId) ?? 0, existingRuns, renumber, plan);
      plan.tasks.push({
        originalId: task.id ?? null,
        finalId,
        action,
        task: { ...task, custom_fields: customFields },
        runs,
        reviews: task.reviews.map((review) => ({
          review,
          // 审核记录的 run_id 只跟包内映射；包外但本地存在的原样保留，其余置空（不留悬空引用）。
          runId: resolveReviewRun(review, runs, existingRuns),
        })),
        currentRun: task.current_run_id ? runs.find((run) => run.originalId === task.current_run_id) ?? null : null,
        normalized: task.status === 'RUNNING',
      });
      if (task.artifacts_missing) artifacts += 1;
    }

    if (artifacts > 0) {
      plan.warnings.push(`${artifacts} 个任务带产物，但产物文件与日志不随导出迁移（6.12.1），未导入任何 artifacts 行`);
    }
    if (renumber) plan.warnings.push('reassign：包内存在号位冲突，任务与 Run 已整包换号，映射见 id_map');
    this.planEdges(plan, existingTasks, req.strategy);
    return plan;
  }

  /** 字段定义先规划：任务的 `custom_fields` 要按「导入后的定义集」校验（20.10）。 */
  private async planFieldDefs(
    defs: ImportedFieldDef[],
    strategy: ImportStrategy | undefined,
    plan: Plan,
  ): Promise<Map<string, FieldDefLike & { enabled: boolean }>> {
    const rows = await this.prisma.customFieldDef.findMany();
    const known = new Map(rows.map((row) => [row.key, defFromRow(row)]));
    for (const def of defs) {
      const exists = known.has(def.key);
      // `key` 是唯一列，换号也换不出第二个同名键：reassign 在这里等同 skip。
      const action: Action = !exists ? 'create' : strategy === 'overwrite' ? 'update' : 'skip';
      if (exists) {
        plan.conflicts.push({
          kind: 'field_def',
          id: def.key,
          detail:
            action === 'update'
              ? '本地已有同 key 定义，按 overwrite 覆盖列属性'
              : strategy === 'reassign'
                ? '本地已有同 key 定义：key 是任务数据引用的锚点，不能重编号，本次保留本地定义'
                : '本地已有同 key 定义，本次保留本地定义',
        });
      }
      if (action === 'skip') plan.skipped.push({ kind: 'field_def', id: def.key, reason: 'key_conflict' });
      plan.fieldDefs.push({ action, def });
      known.set(def.key, defFromImport(def));
    }
    return known;
  }

  private async planTemplates(
    templates: ImportedTemplate[],
    strategy: ImportStrategy | undefined,
    plan: Plan,
  ): Promise<void> {
    const names = new Set(
      (await this.prisma.taskTemplate.findMany({ select: { name: true } })).map((row) => row.name),
    );
    for (const tpl of templates) {
      const exists = names.has(tpl.name);
      const action: Action = !exists ? 'create' : strategy === 'overwrite' ? 'update' : 'skip';
      if (exists) {
        plan.conflicts.push({
          kind: 'template',
          id: tpl.name,
          detail: action === 'update' ? '本地已有同名模板，按 overwrite 覆盖' : '本地已有同名模板，本次保留本地模板',
        });
      }
      if (action === 'skip') plan.skipped.push({ kind: 'template', id: tpl.name, reason: 'name_conflict' });
      else names.add(tpl.name);
      plan.templates.push({ action, tpl });
    }
  }

  private planEdges(
    plan: Plan,
    existingTasks: Map<string, { id: string; status: string }>,
    strategy: ImportStrategy | undefined,
  ): void {
    const landed = new Map<string, string>();
    const skipped = new Set<string>();
    for (const item of plan.tasks) {
      if (item.action === 'skip') skipped.add(item.finalId);
      else if (item.originalId) landed.set(item.originalId, item.finalId);
    }

    const seen = new Set<string>();
    for (const item of plan.tasks) {
      if (item.action === 'skip') continue;
      for (const edge of item.task.dependencies) {
        // reassign 下包外 id 有歧义（同号可能是另一台机器的任务），只有 skip/overwrite 才允许指向本地既有任务。
        const localOnly = strategy !== 'reassign' && existingTasks.has(edge.depends_on);
        const mapped = landed.get(edge.depends_on);
        const target = mapped ?? (localOnly && !skipped.has(edge.depends_on) ? edge.depends_on : undefined);
        if (!target) {
          plan.dropped.push({
            task_id: item.finalId,
            depends_on: edge.depends_on,
            reason: skipped.has(edge.depends_on)
              ? 'target_skipped'
              : existingTasks.has(edge.depends_on)
                ? 'target_ambiguous'
                : 'target_missing',
          });
          continue;
        }
        if (target === item.finalId) {
          plan.dropped.push({ task_id: item.finalId, depends_on: edge.depends_on, reason: 'self_reference' });
          continue;
        }
        const key = `${item.finalId} ${target}`;
        if (seen.has(key)) continue;
        seen.add(key);
        plan.edges.push({ task_id: item.finalId, depends_on: target, type: edge.type, target_local: mapped === undefined });
      }
    }
  }

  /** 覆盖场景不删本地 Run 历史，导入的 Run 从本地最大号往后追加（6.12.2）。 */
  private planRuns(
    task: ImportedTask,
    action: Action,
    localMax: number,
    existingRuns: Map<string, string>,
    renumber: boolean,
    plan: Plan,
  ): RunPlan[] {
    const out: RunPlan[] = [];
    let highest = action === 'update' ? localMax : 0;
    for (const [index, run] of task.runs.entries()) {
      const taken = run.id ? existingRuns.has(run.id) : false;
      const keepId = !!run.id && !renumber && !taken;
      const finalId = keepId ? run.id! : `R-${(plan.runCursor += 1)}`;
      if (keepId) plan.keptRunMax = Math.max(plan.keptRunMax, numericSuffix(run.id!, 'R-') ?? 0);
      let runNumber = run.run_number ?? index + 1;
      if (action === 'update' || runNumber <= highest) runNumber = highest + 1;
      highest = runNumber;
      out.push({
        originalId: run.id ?? null,
        finalId,
        runNumber,
        normalized: run.status === 'RUNNING',
        run,
      });
    }
    return out;
  }

  private async sequences(): Promise<{ task: number; run: number }> {
    const rows = await this.prisma.$queryRawUnsafe<{ name: string; next: number }[]>(
      "SELECT name, next FROM id_sequences WHERE name IN ('task', 'run')",
    );
    const map = new Map(rows.map((row) => [row.name, Number(row.next)]));
    return { task: map.get('task') ?? 1000, run: map.get('run') ?? 2000 };
  }

  private async existingTasks(ids: string[]): Promise<Map<string, { id: string; status: string }>> {
    const rows: { id: string; status: string }[] = [];
    // 一次 `IN` 展开成同样多的绑定参数，包大了会撞 SQLite 的变量上限，所以分块取
    for (let index = 0; index < ids.length; index += TASK_IN_CHUNK) {
      rows.push(
        ...(await this.prisma.task.findMany({
          where: { id: { in: ids.slice(index, index + TASK_IN_CHUNK) } },
          select: { id: true, status: true },
        })),
      );
    }
    return new Map(rows.map((row) => [row.id, row]));
  }

  private async existingRuns(ids: string[]): Promise<Map<string, string>> {
    if (!ids.length) return new Map();
    const rows = await this.prisma.taskRun.findMany({ where: { id: { in: ids } }, select: { id: true, taskId: true } });
    return new Map(rows.map((row) => [row.id, row.taskId]));
  }

  private async localRunNumbers(ids: string[]): Promise<Map<string, number>> {
    if (!ids.length) return new Map();
    const rows = await this.prisma.taskRun.groupBy({
      by: ['taskId'],
      where: { taskId: { in: ids } },
      _max: { runNumber: true },
    });
    return new Map(rows.map((row) => [row.taskId, row._max.runNumber ?? 0]));
  }

  // ---------------------------------------------------------------- 落库

  /** 沿用了文件里的号位时，序列要抬到号位之上，否则后续新建会撞主键。 */
  private async bumpSequences(plan: Plan): Promise<void> {
    const taskMax = Math.max(plan.taskCursor, plan.keptTaskMax);
    const runMax = Math.max(plan.runCursor, plan.keptRunMax);
    if (taskMax > 0) {
      await this.prisma.$executeRawUnsafe("UPDATE id_sequences SET next = MAX(next, ?) WHERE name = 'task'", taskMax);
    }
    if (runMax > 0) {
      await this.prisma.$executeRawUnsafe("UPDATE id_sequences SET next = MAX(next, ?) WHERE name = 'run'", runMax);
    }
  }

  private async apply(plan: Plan): Promise<{ runs: number; reviews: number; edges: number; failed: ImportFailure[] }> {
    const failed: ImportFailure[] = [];
    let runs = 0;
    let reviews = 0;
    let edges = 0;

    for (const item of plan.fieldDefs) {
      if (item.action === 'skip') continue;
      try {
        await writeFieldDef(this.prisma, item);
      } catch (error) {
        failed.push({ kind: 'field_def', id: item.def.key, code: 'INTERNAL', detail: message(error) });
      }
    }
    for (const item of plan.templates) {
      if (item.action === 'skip') continue;
      try {
        await writeTemplate(this.prisma, item);
      } catch (error) {
        failed.push({ kind: 'template', id: item.tpl.name, code: 'INTERNAL', detail: message(error) });
      }
    }

    // 6.12.2 导入顺序：字段定义 → 模板 → 任务（含 Run 与审核）→ 依赖边。
    const written = new Set<string>();
    for (const item of plan.tasks) {
      if (item.action === 'skip') continue;
      try {
        const counts = await this.writeTask(item);
        written.add(item.finalId);
        runs += counts.runs;
        reviews += counts.reviews;
      } catch (error) {
        failed.push({ kind: 'task', id: item.finalId, code: 'INTERNAL', detail: message(error) });
      }
    }

    for (const edge of plan.edges) {
      // 指向本地既有任务的边（`target_local`）本来就是「导入后真实存在」的号位，不该算写失败。
      const targetOk = edge.target_local || written.has(edge.depends_on);
      if (!written.has(edge.task_id) || !targetOk) {
        plan.dropped.push({ task_id: edge.task_id, depends_on: edge.depends_on, reason: 'task_failed' });
        continue;
      }
      try {
        if (await this.writeEdge(edge, plan)) edges += 1;
      } catch (error) {
        // 唯一列 (task_id, depends_on) 重复是本地已有同一条边，按已存在处理。
        this.logger.warn(`依赖边 ${edge.task_id} → ${edge.depends_on} 写入失败：${message(error)}`, 'data');
      }
    }

    for (const item of plan.tasks) {
      if (written.has(item.finalId)) await this.patchTaskPointers(item);
    }
    return { runs, reviews, edges, failed };
  }

  /** 任务 + 它的 Run + 它的审核记录是一个整体；一条失败不牵连同包其他任务。 */
  private async writeTask(item: TaskPlan): Promise<{ runs: number; reviews: number }> {
    return this.prisma.$transaction(async (tx) => {
      const task = item.task;
      const shared = {
        type: task.type,
        title: task.title,
        description: task.description ?? null,
        status: item.normalized ? 'READY' : task.status,
        priority: task.priority,
        tags: JSON.stringify(task.tags),
        requiredCapabilities: JSON.stringify(task.required_capabilities),
        customFields: JSON.stringify(task.custom_fields),
        pinned: task.pinned ? 1 : 0,
        dueAt: task.due_at ? toDateOnly(task.due_at) : null,
        archivedAt: task.archived_at ? toSqlTime(task.archived_at) : null,
        updatedAt: task.updated_at ? toSqlTime(task.updated_at) : nowSql(),
      };
      const id = item.finalId;

      if (item.action === 'update') {
        await tx.task.update({
          where: { id },
          data: {
            ...shared,
            // 状态归一后不能留租约：租约是「谁正在执行」的凭据，导入包里的租约无人持有。
            leaseId: null,
            leaseExpiresAt: null,
            leaseRevokedAt: null,
            claimedAt: null,
            stopReason: null,
            createdAt: task.created_at ? toSqlTime(task.created_at) : undefined,
          },
        });
      } else {
        await tx.task.create({
          data: {
            ...shared,
            id,
            createdAt: task.created_at ? toSqlTime(task.created_at) : nowSql(),
            runCount: 0,
          },
        });
      }

      let runs = 0;
      for (const run of item.runs) {
        await tx.taskRun.create({
          data: {
            id: run.finalId,
            taskId: id,
            runNumber: run.runNumber,
            // 导入包里的 RUNNING 一律转 ABANDONED：它没有可续期的租约。
            status: run.normalized ? 'ABANDONED' : (run.run.status ?? 'SUCCESS'),
            triggerType: run.run.trigger_type ?? 'manual_retry',
            agentName: run.run.agent_name ?? null,
            startedAt: run.run.started_at ? toSqlTime(run.run.started_at) : nowSql(),
            finishedAt: run.run.finished_at ? toSqlTime(run.run.finished_at) : null,
            durationMs: run.run.duration_ms ?? null,
            summary: run.run.summary ?? null,
            progress: run.run.progress ?? null,
            progressMsg: run.run.progress_msg ?? null,
          },
        });
        runs += 1;
      }

      let reviews = 0;
      for (const review of item.reviews) {
        await tx.review.create({
          data: {
            id: newId(),
            taskId: id,
            runId: review.runId,
            conclusion: review.review.conclusion,
            suggestion: review.review.suggestion,
            reason: review.review.reason,
            detail: review.review.detail,
            returnTo: review.review.return_to ?? null,
            priorityAdj: review.review.priority_adj ?? null,
            createdAt: review.review.created_at ? toSqlTime(review.review.created_at) : nowSql(),
          },
        });
        reviews += 1;
      }
      return { runs, reviews };
    });
  }

  private async writeEdge(
    edge: { task_id: string; depends_on: string; type: string },
    plan: Plan,
  ): Promise<boolean> {
    if (edge.type === 'blocks' && (await this.wouldCycle(edge.task_id, edge.depends_on))) {
      plan.dropped.push({ task_id: edge.task_id, depends_on: edge.depends_on, reason: 'cycle_detected' });
      return false;
    }
    await this.prisma.taskDependency.create({
      data: { id: newId(), taskId: edge.task_id, dependsOn: edge.depends_on, type: edge.type, createdAt: nowSql() },
    });
    return true;
  }

  /** `A` 依赖 `B`，而 `B` 已能传递依赖回 `A` 时再补这条边就成环——认领 SQL 会永久取不到任务。 */
  private async wouldCycle(taskId: string, dependsOn: string): Promise<boolean> {
    const rows = await this.prisma.taskDependency.findMany({
      where: { type: 'blocks' },
      select: { taskId: true, dependsOn: true },
    });
    const graph = new Map<string, string[]>();
    for (const row of rows) {
      const list = graph.get(row.taskId);
      if (list) list.push(row.dependsOn);
      else graph.set(row.taskId, [row.dependsOn]);
    }
    const stack = [dependsOn];
    const seen = new Set<string>();
    while (stack.length) {
      const current = stack.pop()!;
      if (current === taskId) return true;
      if (seen.has(current)) continue;
      seen.add(current);
      stack.push(...(graph.get(current) ?? []));
    }
    return false;
  }

  /** Run 全部写完再补 `current_run_id` 与 `run_count`：这两列没有外键，靠这里保证不悬空。 */
  private async patchTaskPointers(item: TaskPlan): Promise<void> {
    const rows = await this.prisma.taskRun.findMany({
      where: { taskId: item.finalId },
      select: { id: true, runNumber: true },
      orderBy: { runNumber: 'desc' },
    });
    const data: { runCount: number; currentRunId?: string | null } = {
      // 包里声明的 run_count 可能大于实际导入的条数（Run 不完整的包），取较大者保历史。
      runCount: Math.max(rows.length, item.task.run_count ?? 0),
    };
    if (item.task.current_run_id) {
      data.currentRunId = item.currentRun ? (rows.find((row) => row.id === item.currentRun?.finalId)?.id ?? null) : null;
    }
    if (item.normalized) data.currentRunId = null;
    await this.prisma.task.update({ where: { id: item.finalId }, data });
  }
}

// ------------------------------------------------------------------ 解析与工具

interface Payload {
  version?: number;
  tasks: unknown[];
  fieldDefs: unknown[];
  templates: unknown[];
}

function decode(buffer: Buffer): Payload {
  const text = buffer.toString('utf8').replace(/^\uFEFF/, '');
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (error) {
    throw new ApiException('VALIDATION_FAILED', `导入文件不是合法 JSON：${message(error)}`, [
      { path: 'file', code: 'invalid_json', message: '请使用导出功能生成的 .json 文件' },
    ]);
  }
  const parsed = importPayloadSchema.safeParse(raw);
  if (!parsed.success) {
    throw new ApiException('VALIDATION_FAILED', '导入文件结构不符，应为 {version, custom_field_defs, templates, tasks}', {
      issues: parsed.error.issues.slice(0, 20),
    });
  }
  const payload = parsed.data;
  for (const [key, list] of [
    ['tasks', payload.tasks],
    ['custom_field_defs', payload.custom_field_defs],
    ['templates', payload.templates],
  ] as const) {
    if (list.length > MAX_ITEMS) {
      throw new ApiException('VALIDATION_FAILED', `${key} 超过单包上限 ${MAX_ITEMS} 条`, [
        { path: key, code: 'too_many_items', message: '请分批导出后再导入' },
      ]);
    }
  }
  return { version: payload.version, tasks: payload.tasks, fieldDefs: payload.custom_field_defs, templates: payload.templates };
}

type ItemKind = 'task' | 'field_def' | 'template';

/** 只用到 `safeParse`，写成结构化类型即可——带 default 的 schema 输入输出不同型，套 `z.ZodType` 会打架。 */
interface Parser<T> {
  safeParse(data: unknown): {
    success: boolean;
    data?: T;
    error?: { issues: { message: string }[] };
  };
}

function collect<T>(items: unknown[], schema: Parser<T>, kind: ItemKind, plan: Plan): T[] {
  const out: T[] = [];
  for (const [index, item] of items.entries()) {
    const parsed = schema.safeParse(item);
    if (parsed.success && parsed.data !== undefined) {
      out.push(parsed.data);
      continue;
    }
    // 坏条目只影响它自己：整包回滚会让用户为一个错别字重做全部导入。
    const id = (item as { id?: unknown } | null)?.id;
    plan.failed.push({
      kind,
      id: typeof id === 'string' ? id : `${kind}#${index + 1}`,
      code: 'VALIDATION_FAILED',
      detail: parsed.error?.issues?.[0]?.message ?? '结构不符',
    });
  }
  return out;
}

function checkTask(
  task: ImportedTask,
  types: string[],
  defs: Map<string, FieldDefLike & { enabled: boolean }>,
): string[] {
  const issues: string[] = [];
  if (!types.includes(task.type)) issues.push(`任务类型「${task.type}」不在词表内`);
  for (const [key, value] of Object.entries(task.custom_fields)) {
    const def = defs.get(key);
    if (!def || !def.enabled) {
      issues.push(`自定义字段「${key}」无定义或已停用`);
      continue;
    }
    if (!appliesToType(def, task.type)) {
      issues.push(`自定义字段「${key}」不适用于类型「${task.type}」`);
      continue;
    }
    const issue = validateFieldValue(def, value, { present: true });
    if (issue) issues.push(`自定义字段「${issue.key}」：${issue.message}`);
  }
  return issues;
}

function resolveReviewRun(review: ImportedReview, runs: RunPlan[], existingRuns: Map<string, string>): string | null {
  if (!review.run_id) return null;
  const imported = runs.find((run) => run.originalId === review.run_id);
  if (imported) return imported.finalId;
  return existingRuns.has(review.run_id) ? review.run_id : null;
}

function defFromRow(row: {
  key: string;
  label: string;
  type: string;
  required: number;
  options: string | null;
  appliesTo: string | null;
  enabled: number;
}): FieldDefLike & { enabled: boolean } {
  return {
    key: row.key,
    label: row.label,
    type: row.type as FieldType,
    required: row.required === 1,
    options: parseOptions(row.options),
    appliesTo: parseJsonArray(row.appliesTo),
    enabled: row.enabled === 1,
  };
}

function defFromImport(def: ImportedFieldDef): FieldDefLike & { enabled: boolean } {
  const options: FieldOptions = Array.isArray(def.options)
    ? def.options.map(String)
    : def.options && typeof def.options === 'object'
      ? (def.options as { min?: number; max?: number })
      : null;
  return {
    key: def.key,
    label: def.label,
    type: def.type as FieldType,
    required: def.required,
    options,
    appliesTo: def.applies_to,
    enabled: def.enabled,
  };
}

function parseOptions(raw: string | null): FieldOptions {
  if (!raw) return null;
  try {
    const value: unknown = JSON.parse(raw);
    if (Array.isArray(value)) return value.map(String);
    if (value && typeof value === 'object') return value as FieldOptions;
    return null;
  } catch {
    return null;
  }
}

async function writeFieldDef(
  prisma: PrismaService,
  item: { action: Action; def: ImportedFieldDef },
): Promise<void> {
  const def = item.def;
  const data = {
    key: def.key,
    label: def.label,
    type: def.type,
    required: def.required ? 1 : 0,
    defaultValue: def.default_value ?? null,
    options: def.options === undefined || def.options === null ? null : JSON.stringify(def.options),
    appliesTo: JSON.stringify(def.applies_to),
    showOnCard: def.show_on_card ? 1 : 0,
    sortOrder: def.sort_order,
    enabled: def.enabled ? 1 : 0,
    updatedAt: nowSql(),
  };
  if (item.action === 'update') {
    await prisma.customFieldDef.update({ where: { key: def.key }, data });
    return;
  }
  // 包里的定义 id 是另一台机器的 UUID，沿用会撞本地主键；键名才是跨机身份。
  await prisma.customFieldDef.create({ data: { ...data, id: newId(), createdAt: nowSql() } });
}

async function writeTemplate(
  prisma: PrismaService,
  item: { action: Action; tpl: ImportedTemplate },
): Promise<void> {
  const data = {
    name: item.tpl.name,
    description: item.tpl.description ?? null,
    preset: JSON.stringify(item.tpl.preset ?? {}),
    sortOrder: item.tpl.sort_order,
  };
  if (item.action === 'update') {
    const existing = await prisma.taskTemplate.findFirst({
      where: { name: item.tpl.name },
      select: { id: true },
    });
    if (existing) {
      await prisma.taskTemplate.update({ where: { id: existing.id }, data });
      return;
    }
  }
  await prisma.taskTemplate.create({ data: { ...data, id: newId(), createdAt: nowSql() } });
}

function numericSuffix(id: string, prefix: 'T-' | 'R-'): number | null {
  const match = new RegExp(`^${prefix}(\\d+)$`).exec(id);
  return match ? Number(match[1]) : null;
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function summarize(plan: Plan, req: ImportRequest, backup: { name: string; path: string } | null): ImportResult {
  const landing = plan.tasks.filter((item) => item.action !== 'skip');
  const taskMap: Record<string, string> = {};
  const runMap: Record<string, string> = {};
  for (const item of landing) {
    if (item.originalId && item.originalId !== item.finalId) taskMap[item.originalId] = item.finalId;
    for (const run of item.runs) {
      if (run.originalId && run.originalId !== run.finalId) runMap[run.originalId] = run.finalId;
    }
  }
  const count = <T extends { action: Action }>(items: T[]): ImportCounters => ({
    new: items.filter((item) => item.action === 'create').length,
    updated: items.filter((item) => item.action === 'update').length,
    skipped: items.filter((item) => item.action === 'skip').length,
  });
  return {
    dry_run: req.dry_run,
    strategy: req.strategy ?? null,
    backup,
    tasks: count(plan.tasks),
    field_defs: count(plan.fieldDefs),
    templates: count(plan.templates),
    runs: { new: landing.reduce((total, item) => total + item.runs.length, 0) },
    reviews: { new: landing.reduce((total, item) => total + item.reviews.length, 0) },
    dependencies: { new: plan.edges.length },
    conflicts: plan.conflicts,
    imported: {
      tasks: landing.map((item) => item.finalId),
      field_defs: plan.fieldDefs.filter((item) => item.action !== 'skip').map((item) => item.def.key),
      templates: plan.templates.filter((item) => item.action !== 'skip').map((item) => item.tpl.name),
    },
    skipped: plan.skipped,
    failed: plan.failed,
    dropped_dependencies: plan.dropped,
    id_map: { tasks: taskMap, runs: runMap },
    warnings: plan.warnings,
  };
}
