import { z } from 'zod';

/** v0.0.4 W1b：术语迁移 Project→Group（需求.md §21.1），本文件的 `project*` 标识符一律改 `group*`。 */

export const groupCreateSchema = z.object({
  name: z.string().trim().min(1).max(50),
  color: z.string().trim().max(16).optional(),
  icon: z.string().trim().max(16).optional(),
  description: z.string().trim().max(2000).optional(),
  sort: z.number().int().optional(),
});
export type GroupCreateInput = z.infer<typeof groupCreateSchema>;

export const groupPatchSchema = z
  .object({
    name: z.string().trim().min(1).max(50).optional(),
    color: z.string().trim().max(16).nullable().optional(),
    icon: z.string().trim().max(16).nullable().optional(),
    description: z.string().trim().max(2000).nullable().optional(),
    status: z.enum(['ACTIVE', 'ARCHIVED']).optional(),
    sort: z.number().int().optional(),
  })
  .refine((value) => Object.keys(value).length > 0, { message: '没有需要更新的字段' });
export type GroupPatchInput = z.infer<typeof groupPatchSchema>;

/** §16.2 `DELETE /api/v1/groups/{id}?strategy=migrate|cascade`（§5.4 的两种任务处理）。 */
export const groupDeleteQuerySchema = z.object({
  strategy: z.enum(['migrate', 'cascade']).default('cascade'),
  targetGroupId: z.string().trim().min(1).max(64).optional(),
});
export type GroupDeleteQuery = z.infer<typeof groupDeleteQuerySchema>;

/**
 * §5.6/§16.2（r3）`GET /api/v1/groups?archived=true`：默认只回活跃分组
 * （归档分组从分组切换器/泳道默认隐藏），`archived=true` 连归档组一起给。
 */
export const groupListQuerySchema = z.object({
  archived: z.enum(['true']).optional(),
});
export type GroupListQuery = z.infer<typeof groupListQuerySchema>;

export const prefPutSchema = z.object({
  value: z.unknown(),
});
export type PrefPutInput = z.infer<typeof prefPutSchema>;
