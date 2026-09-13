import { z } from 'zod';
import {
  ARCHIVED_FILTERS,
  BOARD_VIEWS,
  COMMENT_TYPES,
  DEP_TYPES,
  FIELD_TYPES,
  LIST_SORT_FIELDS,
  RETURN_TARGETS,
  REVIEW_CONCLUSIONS,
  TAG_MAX_LENGTH,
  TAGS_MAX_PER_TASK,
  TASK_STATUS,
} from './enums';

/** 20.5 能力标识：namespace:value，命名空间小写 ASCII。未约定的命名空间不校验取值。 */
export const CAPABILITY_RE = /^[a-z][a-z0-9_-]*:[^\s]+$/;

export const capabilitySchema = z
  .string()
  .trim()
  .regex(CAPABILITY_RE, '格式为 namespace:value')
  .max(64);

export const tagsSchema = z
  .array(z.string().trim().min(1).max(TAG_MAX_LENGTH))
  .max(TAGS_MAX_PER_TASK)
  .transform((list) => [...new Set(list)]);

export const customFieldsSchema = z.record(z.string(), z.unknown());

/** 20.4：入参接受 ISO（含或不含 Z）或 YYYY-MM-DD，服务端归一。 */
export const dateInputSchema = z.union([
  z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  z.string().datetime({ offset: true }),
  z.string().datetime(),
]);

export const idLike = z.string().trim().min(3).max(24);
const idParam = idLike;

/**
 * 查询串数组参数：Express 的 qs 对单值给 `string`、多值给 `string[]`，
 * 这里两种都吃，另外支持 `?tags=a,b`。空值一律归一为 `[]`。
 */
export const stringListSchema = z
  .union([z.string(), z.array(z.string())])
  .transform((raw) => (Array.isArray(raw) ? raw : raw.split(',')))
  .transform((list) => [...new Set(list.map((item) => item.trim()).filter(Boolean))]);

const enumList = <T extends readonly [string, ...string[]]>(values: T) =>
  stringListSchema.pipe(z.array(z.enum(values)).max(values.length));

/** 评论读取：`?type=comment,status_change`，逗号分隔。 */
export const commentTypeListSchema = enumList(
  COMMENT_TYPES as unknown as readonly [string, ...string[]],
);

/** 20.2 优先级：0 紧急 / 1 高 / 2 中 / 3 低。body 里是数字，查询串里是字符串，一律 coerce。 */
export const prioritySchema = z.coerce.number().int().min(0).max(3);
const priorityListSchema = stringListSchema
  .transform((list) => list.map(Number))
  .pipe(z.array(z.number().int().min(0).max(3)));

export const taskCreateSchema = z.object({
  title: z.string().trim().min(1).max(200),
  type: z.string().trim().min(1).max(16),
  priority: prioritySchema.default(3),
  description: z.string().max(20000).optional(),
  tags: tagsSchema.default([]),
  required_capabilities: z.array(capabilitySchema).max(20).default([]),
  custom_fields: customFieldsSchema.default({}),
  due_at: dateInputSchema.optional(),
  depends_on: z.array(idParam).max(50).default([]),
  dependency_type: z.enum(DEP_TYPES).default('blocks'),
  pinned: z.boolean().default(false),
});
export type TaskCreateInput = z.infer<typeof taskCreateSchema>;

/** 8.1：创建后进 BACKLOG，status 不在可写字段内；RUNNING 一律由认领事务产生（4.3.1 规则 2）。 */
export const taskPatchSchema = z
  .object({
    title: z.string().trim().min(1).max(200).optional(),
    type: z.string().trim().min(1).max(16).optional(),
    priority: prioritySchema.optional(),
    description: z.string().max(20000).nullable().optional(),
    tags: tagsSchema.optional(),
    required_capabilities: z.array(capabilitySchema).max(20).optional(),
    custom_fields: customFieldsSchema.optional(),
    due_at: dateInputSchema.nullable().optional(),
    pinned: z.boolean().optional(),
  })
  .refine((value) => Object.keys(value).length > 0, { message: '没有需要更新的字段' });
export type TaskPatchInput = z.infer<typeof taskPatchSchema>;

export const transitionSchema = z.object({
  to: z.enum(TASK_STATUS),
  /** 4.5：`🔒` 目标不由本端点承接（审核表单 / 强制停止各有端点），此处只接受 direct 流转。 */
  comment: z.string().max(2000).optional(),
});
export type TransitionInput = z.infer<typeof transitionSchema>;

export const reviewSchema = z
  .object({
    conclusion: z.enum(REVIEW_CONCLUSIONS),
    suggestion: z.string().trim().min(1).max(5000),
    reason: z.string().trim().min(1).max(5000),
    detail: z.string().trim().min(1).max(5000),
    return_to: z.enum(RETURN_TARGETS).optional(),
    priority_adj: prioritySchema.optional(),
    run_id: idParam.optional(),
  })
  .superRefine((value, ctx) => {
    if (value.conclusion === 'REJECT' && !value.return_to) {
      ctx.addIssue({ code: 'custom', path: ['return_to'], message: '驳回必须指定退回目标' });
    }
    if (value.conclusion === 'APPROVE' && value.return_to) {
      ctx.addIssue({ code: 'custom', path: ['return_to'], message: '通过时不应有退回目标' });
    }
  });
export type ReviewInput = z.infer<typeof reviewSchema>;

export const stopSchema = z.object({
  /** 4.3.1 规则 2：强制停止是人的操作，不要求理由，但给了就记进审计。 */
  reason: z.string().trim().max(2000).optional(),
});
export type StopInput = z.infer<typeof stopSchema>;

export const commentSchema = z.object({
  content: z.string().trim().min(1).max(20000),
  run_id: idParam.optional(),
});
export type CommentInput = z.infer<typeof commentSchema>;

export const dependencyCreateSchema = z.object({
  depends_on: idParam,
  type: z.enum(DEP_TYPES).default('blocks'),
});
export type DependencyCreateInput = z.infer<typeof dependencyCreateSchema>;

export const batchIdsSchema = z.object({ ids: z.array(idParam).min(1).max(200) });
export type BatchIdsInput = z.infer<typeof batchIdsSchema>;

export const batchTransitionSchema = z.object({
  ids: z.array(idParam).min(1).max(200),
  to: z.enum(TASK_STATUS),
});
export type BatchTransitionInput = z.infer<typeof batchTransitionSchema>;

export const batchTagsSchema = z
  .object({
    ids: z.array(idParam).min(1).max(200),
    add: tagsSchema.default([]),
    remove: tagsSchema.default([]),
  })
  .refine((value) => value.add.every((tag) => !value.remove.includes(tag)), {
    message: '同一标签不能同时出现在 add 与 remove',
  });
export type BatchTagsInput = z.infer<typeof batchTagsSchema>;

export const fieldOptionsSchema = z.union([
  z.array(z.string().trim().min(1).max(64)).min(1).max(100),
  z.object({ min: z.number().optional(), max: z.number().optional() }),
]);

export const fieldDefCreateSchema = z.object({
  key: z
    .string()
    .regex(/^[a-z][a-z0-9_]{1,31}$/, 'key 需匹配 ^[a-z][a-z0-9_]{1,31}$'),
  label: z.string().trim().min(1).max(32),
  type: z.enum(FIELD_TYPES),
  required: z.boolean().default(false),
  default_value: z.string().max(5000).nullable().optional(),
  options: fieldOptionsSchema.nullable().optional(),
  applies_to: z.array(z.string().trim().min(1).max(16)).default([]),
  show_on_card: z.boolean().default(false),
  sort_order: z.number().int().min(0).max(999).default(0),
  enabled: z.boolean().default(true),
});
export type FieldDefCreateInput = z.infer<typeof fieldDefCreateSchema>;

/**
 * 13 章：`key` 与 `type` 保存后不可改，改它们 = 换字段，旧值无处迁移。
 * zod 4 的 `z.any()` 是非可选的，少了 `.optional()` 就会把「缺省不改」判成
 * 「缺键」，于是任何 PATCH 都被拒——占位键必须显式可选。
 */
const immutableFieldDefKey = z
  .any()
  .optional()
  .refine((value) => value === undefined, { message: '保存后不可修改' });

export const fieldDefPatchSchema = z
  .object({
    label: z.string().trim().min(1).max(32).optional(),
    required: z.boolean().optional(),
    default_value: fieldDefCreateSchema.shape.default_value,
    options: fieldDefCreateSchema.shape.options,
    applies_to: z.array(z.string().trim().min(1).max(16)).optional(),
    show_on_card: z.boolean().optional(),
    sort_order: z.number().int().min(0).max(999).optional(),
    enabled: z.boolean().optional(),
    key: immutableFieldDefKey,
    type: immutableFieldDefKey,
  })
  .refine((value) => Object.keys(value).length > 0, { message: '没有需要更新的字段' });
export type FieldDefPatchInput = z.infer<typeof fieldDefPatchSchema>;

export const templatePresetSchema = z.object({
  type: z.string().trim().min(1).max(16).optional(),
  priority: z.number().int().min(0).max(3).optional(),
  description: z.string().max(20000).optional(),
  tags: tagsSchema.optional(),
  required_capabilities: z.array(capabilitySchema).max(20).optional(),
  custom_fields: customFieldsSchema.optional(),
  due_offset_days: z.number().int().min(0).max(365).optional(),
});
export type TemplatePreset = z.infer<typeof templatePresetSchema>;

export const templateCreateSchema = z.object({
  name: z.string().trim().min(1).max(64),
  description: z.string().max(2000).optional(),
  preset: templatePresetSchema,
  sort_order: z.number().int().min(0).max(999).default(0),
});

export const templatePatchSchema = templateCreateSchema.partial();
export type TemplateCreateInput = z.infer<typeof templateCreateSchema>;
export type TemplatePatchInput = z.infer<typeof templatePatchSchema>;

export const tokenCreateSchema = z.object({
  name: z
    .string()
    .trim()
    .min(2)
    .max(32)
    .regex(/^[a-z0-9][a-z0-9_-]*$/, '名称用小写字母、数字、- 或 _（界面与 Agent 配置里同源显示）'),
  capabilities: z.array(capabilitySchema).max(20).default([]),
});
export type TokenCreateInput = z.infer<typeof tokenCreateSchema>;

export const settingsPatchSchema = z.record(z.string(), z.unknown()).refine(
  (value) => Object.keys(value).length > 0,
  { message: '没有需要更新的设置' },
);

/** 6.7：`?unread=true` 只看未读，缺省给全部。 */
export const notificationsQuerySchema = z.object({
  unread: z.enum(['true', 'false']).default('false'),
});

/** 13 章：`{ids:[]}` 或 `{all:true}`，两者都不给等于「什么都不要标」，直接拒。 */
export const markReadSchema = z
  .object({
    ids: z.array(idParam).max(500).optional(),
    all: z.boolean().optional(),
  })
  .refine((value) => (value.ids?.length ?? 0) > 0 || value.all === true, {
    message: '需要 ids 或 all=true',
  });

/** 4.10 / 7.7：审计列表只有 target 过滤，`page_size` 固定 50 不开放。 */
export const auditQuerySchema = z.object({
  target_type: z.string().trim().max(32).optional(),
  target_id: idLike.optional(),
  page: z.coerce.number().int().min(1).default(1),
});
export type AuditQuery = z.infer<typeof auditQuerySchema>;

/** 字段定义的 key 规则，同时用来约束查询串里的 `custom_fields[key]`，键名不进 SQL 拼接。 */
export const FIELD_KEY_RE = /^[a-z][a-z0-9_]{1,31}$/;

/**
 * `?custom_fields[severity]=高&custom_fields[platform]=ios&custom_fields[platform]=macos`
 * 键名不合规则直接 422：悄悄丢掉一个条件等于多返回一批任务。
 */
export const customFieldFilterSchema = z
  .record(z.string().regex(FIELD_KEY_RE, '自定义字段 key 需匹配 ^[a-z][a-z0-9_]{1,31}$'), stringListSchema)
  .refine((value) => Object.keys(value).length <= 10, { message: '自定义字段筛选最多 10 个键' });
export type CustomFieldFilter = z.infer<typeof customFieldFilterSchema>;

export const boardQuerySchema = z.object({
  view: z.enum(BOARD_VIEWS).default('all'),
  priority: priorityListSchema.optional(),
  type: stringListSchema.optional(),
  tags: stringListSchema.optional(),
  custom_fields: customFieldFilterSchema.optional(),
});
export type BoardQuery = z.infer<typeof boardQuerySchema>;

export const listQuerySchema = z.object({
  status: enumList(TASK_STATUS as unknown as readonly [string, ...string[]]).optional(),
  keyword: z.string().trim().max(120).optional(),
  priority: priorityListSchema.optional(),
  type: stringListSchema.optional(),
  tags: stringListSchema.optional(),
  custom_fields: customFieldFilterSchema.optional(),
  archived: z.enum(ARCHIVED_FILTERS).default('false'),
  sort: z.enum(LIST_SORT_FIELDS).default('updated_at'),
  order: z.enum(['asc', 'desc']).default('desc'),
  page: z.coerce.number().int().min(1).default(1),
  page_size: z.coerce.number().int().min(1).max(200).default(50),
});
export type ListQuery = z.infer<typeof listQuerySchema>;

/** 详情抽屉「评论」Tab：默认只要人写的评论与系统状态变更，日志有自己的端点。 */
export const commentsQuerySchema = z.object({
  type: commentTypeListSchema.optional(),
  page: z.coerce.number().int().min(1).default(1),
  page_size: z.coerce.number().int().min(1).max(200).default(100),
});
export type CommentsQuery = z.infer<typeof commentsQuerySchema>;

export const paginationSchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  page_size: z.coerce.number().int().min(1).max(200).default(200),
});
export type Pagination = z.infer<typeof paginationSchema>;
