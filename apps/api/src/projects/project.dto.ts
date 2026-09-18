import { z } from 'zod';

export const projectCreateSchema = z.object({
  name: z.string().trim().min(1).max(50),
  color: z.string().trim().max(16).optional(),
  icon: z.string().trim().max(16).optional(),
  description: z.string().trim().max(2000).optional(),
  sort: z.number().int().optional(),
});
export type ProjectCreateInput = z.infer<typeof projectCreateSchema>;

export const projectPatchSchema = z
  .object({
    name: z.string().trim().min(1).max(50).optional(),
    color: z.string().trim().max(16).nullable().optional(),
    icon: z.string().trim().max(16).nullable().optional(),
    description: z.string().trim().max(2000).nullable().optional(),
    status: z.enum(['ACTIVE', 'ARCHIVED']).optional(),
    sort: z.number().int().optional(),
  })
  .refine((value) => Object.keys(value).length > 0, { message: '没有需要更新的字段' });
export type ProjectPatchInput = z.infer<typeof projectPatchSchema>;

export const projectDeleteQuerySchema = z.object({
  strategy: z.enum(['migrate', 'delete']).default('delete'),
  targetProjectId: z.string().trim().min(1).max(64).optional(),
});
export type ProjectDeleteQuery = z.infer<typeof projectDeleteQuerySchema>;

export const prefPutSchema = z.object({
  value: z.unknown(),
});
export type PrefPutInput = z.infer<typeof prefPutSchema>;
