import type { TaskTemplate } from '@prisma/client';
import { z } from 'zod';
import { templateCreateSchema, templatePresetSchema } from '../contract/schemas';
import { parseJsonObject } from '../tasks/task.dto';
import { toIso } from '../contract/time';

/**
 * 6.11.1 的预填集合里含「标题前缀」，而 contract 的 `templatePresetSchema` 没有这个键
 * （该文件对我冻结）。zod 默认丢弃未声明的键，所以这里在本模块补上——不改契约文件，
 * 也不让前端的 title_prefix 在落库前被静默吃掉。
 */
export const presetSchema = templatePresetSchema.extend({
  title_prefix: z.string().trim().max(30).optional(),
});
export type TemplatePresetInput = z.infer<typeof presetSchema>;

/**
 * `name` 的必填与 7.5 表单里的 `*` 由 contract 与前端各自负责；本层只声明多出来的
 * `title_prefix`，并对**提交里出现的**预填键做值校验（见 service），不额外收严成必填——
 * 契约把 preset 的每个键都定为可选，空模板是合法存量。
 */
export const templateCreateBodySchema = templateCreateSchema.extend({ preset: presetSchema });

/**
 * 逐键写 `optional`，不用 `.partial()`：partial 只是包一层 optional，键里带的
 * `.default(0)` 仍会在缺省时回填，「只改名字」的 PATCH 会顺手把 `sort_order` 拍回 0
 * （contract 的 `taskPatchSchema` 同样是逐键写的）。空对象仍拒，免得写噪声审计。
 */
export const templatePatchBodySchema = z
  .object({
    name: templateCreateBodySchema.shape.name.optional(),
    description: templateCreateBodySchema.shape.description,
    preset: presetSchema.optional(),
    sort_order: z.number().int().min(0).max(999).optional(),
  })
  .refine((value) => Object.keys(value).length > 0, { message: '没有需要更新的字段' });

export type TemplateCreateBody = z.infer<typeof templateCreateBodySchema>;
export type TemplatePatchBody = z.infer<typeof templatePatchBodySchema>;

export interface TemplateDto {
  id: string;
  name: string;
  /** 模板自身的说明（列表与「复制」用），与 `preset.description`（预填进任务的描述）不是一回事。 */
  description: string | null;
  sort_order: number;
  created_at: string;
  /**
   * 键名与 `taskCreateSchema` 对齐，验收 25 的「自动填充」= 前端把 preset 摊进建任务表单：
   * `title = title_prefix + 用户输入`，其余键原样进表单。
   */
  preset: TemplatePresetInput;
}

export function toTemplateDto(row: TaskTemplate): TemplateDto {
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    sort_order: row.sortOrder ?? 0,
    created_at: toIso(row.createdAt) ?? row.createdAt,
    preset: decodePreset(row.preset),
  };
}

export function encodePreset(preset: TemplatePresetInput): string {
  return JSON.stringify(preset);
}

/** 库里 `preset` 是 JSON 文本且 NOT NULL；手改过的坏行不抛，退化成原样透传，模板列表不该整页 500。 */
export function decodePreset(raw: string): TemplatePresetInput {
  const parsed = parseJsonObject(raw);
  const result = presetSchema.safeParse(parsed);
  return result.success ? result.data : (parsed as TemplatePresetInput);
}
