import { z } from 'zod';
import {
  DEP_TYPES,
  FIELD_TYPES,
  REVIEW_CONCLUSIONS,
  RUN_STATUS,
  RETURN_TARGETS,
  TASK_STATUS,
  TRIGGER_TYPES,
} from '../contract/enums';
import { customFieldFilterSchema, idLike, stringListSchema } from '../contract/schemas';

/** 13 章数据接口：导出范围的三种取值。CSV 不在阶段一（17.2），所以没有 format 字段。 */
export const EXPORT_SCOPES = ['all', 'filtered', 'selected'] as const;
export const IMPORT_STRATEGIES = ['skip', 'overwrite', 'reassign'] as const;

/** 6.12.1 的导出格式版本；导入时 `version` 大于它直接拒绝，不做向前猜测。 */
export const EXPORT_FORMAT_VERSION = 2;

const enumValues = <T extends readonly string[]>(values: T) =>
  z.enum(values as unknown as readonly [string, ...string[]]);

/** 查询串形态的枚举数组与 `listQuerySchema` 同一套写法（单值 / 数组 / 逗号串都吃）。 */
const enumList = <T extends readonly string[]>(values: T) =>
  stringListSchema.pipe(
    z.array(enumValues(values)).max(values.length),
  );

const priorityListSchema = stringListSchema
  .transform((list) => list.map(Number))
  .pipe(z.array(z.number().int().min(0).max(3)));

/** 「当前筛选」= 任务列表页的筛选状态（原型 7.6），字段与 `listQuerySchema` 同源。 */
export const exportFilterSchema = z.object({
  status: enumList(TASK_STATUS).optional(),
  keyword: z.string().trim().max(120).optional(),
  priority: priorityListSchema.optional(),
  type: stringListSchema.optional(),
  tags: stringListSchema.optional(),
  custom_fields: customFieldFilterSchema.optional(),
});
export type ExportFilter = z.infer<typeof exportFilterSchema>;

export const exportRequestSchema = z.object({
  scope: z.enum(EXPORT_SCOPES).default('all'),
  filter: exportFilterSchema.optional(),
  ids: z.array(idLike).max(2000).optional(),
  include_archived: z.boolean().default(false),
});
export type ExportRequest = z.infer<typeof exportRequestSchema>;

/** multipart 的文本字段一定是字符串，`dry_run` 两种写法都吃。 */
export const importRequestSchema = z.object({
  strategy: z.enum(IMPORT_STRATEGIES).optional(),
  dry_run: z
    .union([z.boolean(), z.enum(['true', 'false', '1', '0'])])
    .default(false)
    .transform((value) => value === true || value === 'true' || value === '1'),
});
export type ImportRequest = z.infer<typeof importRequestSchema>;
export type ImportStrategy = (typeof IMPORT_STRATEGIES)[number];

const boolish = z
  .union([z.boolean(), z.number(), z.string()])
  .transform((value) => value === true || value === 1 || value === '1' || value === 'true');

export const importedDependencySchema = z.object({
  depends_on: z.string().min(1).max(64),
  type: z.enum(DEP_TYPES).default('blocks'),
});

export const importedRunSchema = z.object({
  id: z.string().min(1).max(64).optional(),
  run_number: z.number().int().min(1).optional(),
  status: enumValues(RUN_STATUS).optional(),
  trigger_type: enumValues(TRIGGER_TYPES).optional(),
  agent_name: z.string().max(64).nullable().optional(),
  started_at: z.string().max(40).optional(),
  finished_at: z.string().max(40).nullable().optional(),
  duration_ms: z.number().int().nullable().optional(),
  summary: z.string().max(20000).nullable().optional(),
  progress: z.number().int().min(0).max(100).nullable().optional(),
  progress_msg: z.string().max(500).nullable().optional(),
});
export type ImportedRun = z.infer<typeof importedRunSchema>;

export const importedReviewSchema = z.object({
  run_id: z.string().max(64).nullable().optional(),
  conclusion: enumValues(REVIEW_CONCLUSIONS),
  suggestion: z.string().max(5000).default(''),
  reason: z.string().max(5000).default(''),
  detail: z.string().max(5000).default(''),
  return_to: enumValues(RETURN_TARGETS).nullable().optional(),
  priority_adj: z.number().int().min(0).max(3).nullable().optional(),
  created_at: z.string().max(40).optional(),
});
export type ImportedReview = z.infer<typeof importedReviewSchema>;

export const importedTaskSchema = z.object({
  id: z.string().min(1).max(64).optional(),
  title: z.string().min(1).max(200),
  type: z.string().min(1).max(16).default('需求'),
  status: enumValues(TASK_STATUS).default('BACKLOG'),
  priority: z.number().int().min(0).max(3).default(3),
  description: z.string().max(20000).nullable().optional(),
  tags: z.array(z.string().max(16)).max(10).default([]),
  required_capabilities: z.array(z.string().max(64)).max(20).default([]),
  custom_fields: z.record(z.string(), z.unknown()).default({}),
  pinned: boolish.default(false),
  due_at: z.string().max(40).nullable().optional(),
  archived_at: z.string().max(40).nullable().optional(),
  created_at: z.string().max(40).optional(),
  updated_at: z.string().max(40).optional(),
  run_count: z.number().int().min(0).optional(),
  current_run_id: z.string().max(64).nullable().optional(),
  dependencies: z.array(importedDependencySchema).max(200).default([]),
  runs: z.array(importedRunSchema).max(200).default([]),
  reviews: z.array(importedReviewSchema).max(200).default([]),
  /** 6.12.1：导出包里产物只以缺失标记出现，导入侧不建 artifacts 行（磁盘上没有文件）。 */
  artifacts_missing: z.boolean().optional(),
});
export type ImportedTask = z.infer<typeof importedTaskSchema>;

export const importedFieldDefSchema = z.object({
  id: z.string().max(64).optional(),
  key: z.string().min(1).max(32),
  label: z.string().min(1).max(32),
  type: enumValues(FIELD_TYPES),
  required: boolish.default(false),
  default_value: z.string().max(5000).nullable().optional(),
  options: z.union([z.array(z.string()), z.record(z.string(), z.unknown()), z.null()]).optional(),
  applies_to: z.array(z.string().max(16)).default([]),
  show_on_card: boolish.default(false),
  sort_order: z.number().int().min(0).max(999).default(0),
  enabled: boolish.default(true),
});
export type ImportedFieldDef = z.infer<typeof importedFieldDefSchema>;

export const importedTemplateSchema = z.object({
  id: z.string().max(64).optional(),
  name: z.string().min(1).max(64),
  description: z.string().max(2000).nullable().optional(),
  preset: z.record(z.string(), z.unknown()).default({}),
  sort_order: z.number().int().min(0).max(999).default(0),
});
export type ImportedTemplate = z.infer<typeof importedTemplateSchema>;

/** 导入文件的顶层形状：只卡 `version` 与三大块，块内逐条再校验（一条坏的不该带崩整包）。 */
export const importPayloadSchema = z.object({
  version: z.number().int().min(1).optional(),
  app_version: z.string().max(32).optional(),
  exported_at: z.string().max(40).optional(),
  custom_field_defs: z.array(z.unknown()).default([]),
  templates: z.array(z.unknown()).default([]),
  tasks: z.array(z.unknown()).default([]),
});

// ------------------------------------------------------------------ 导出文档形状（6.12.1）

export interface ExportedRun {
  id: string;
  run_number: number;
  status: string;
  trigger_type: string;
  agent_name: string | null;
  started_at: string | null;
  finished_at: string | null;
  duration_ms: number | null;
  summary: string | null;
  progress: number | null;
  progress_msg: string | null;
}

export interface ExportedReview {
  run_id: string | null;
  conclusion: string;
  suggestion: string;
  reason: string;
  detail: string;
  return_to: string | null;
  priority_adj: number | null;
  created_at: string | null;
}

export interface ExportedTask {
  id: string;
  type: string;
  title: string;
  description: string | null;
  status: string;
  priority: number;
  tags: string[];
  required_capabilities: string[];
  custom_fields: Record<string, unknown>;
  pinned: boolean;
  due_at: string | null;
  archived_at: string | null;
  created_at: string | null;
  updated_at: string | null;
  run_count: number;
  current_run_id: string | null;
  dependencies: { depends_on: string; type: string }[];
  runs: ExportedRun[];
  reviews: ExportedReview[];
  /** 只在确实有产物行时出现：6.12.1 的产物不随导出迁移，UI 据此提示。 */
  artifacts_missing?: true;
}

export interface ExportedFieldDef {
  key: string;
  label: string;
  type: string;
  required: number;
  default_value: string | null;
  options: unknown;
  applies_to: string[];
  show_on_card: number;
  /** 出包时把可空列归成数字：导入侧只收 number，NULL 会让定义与用到它的任务一起失败。 */
  sort_order: number;
  enabled: number;
}

export interface ExportedTemplate {
  name: string;
  description: string | null;
  preset: unknown;
  sort_order: number;
}

export interface ExportDocument {
  version: number;
  app_version: string;
  exported_at: string;
  scope: ExportRequest['scope'];
  counts: { tasks: number; field_defs: number; templates: number; runs: number };
  custom_field_defs: ExportedFieldDef[];
  templates: ExportedTemplate[];
  tasks: ExportedTask[];
}
