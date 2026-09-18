import { z } from 'zod';

export const usernameSchema = z
  .string()
  .trim()
  .regex(/^[a-zA-Z0-9_-]{3,32}$/, '用户名需为 3-32 位字母/数字/下划线/连字符');

export const passwordSchema = z.string().min(6).max(64);

export const loginSchema = z.object({
  username: usernameSchema,
  password: z.string().min(1).max(128),
});
export type LoginInput = z.infer<typeof loginSchema>;

export const initSchema = z.object({
  username: usernameSchema,
  password: passwordSchema,
  display_name: z.string().trim().min(1).max(32).optional(),
});
export type InitInput = z.infer<typeof initSchema>;

export const changePasswordSchema = z.object({
  current_password: z.string().min(1).max(128),
  new_password: passwordSchema,
});
export type ChangePasswordInput = z.infer<typeof changePasswordSchema>;

export const userCreateSchema = z.object({
  username: usernameSchema,
  password: passwordSchema,
  role: z.enum(['ADMIN', 'MEMBER']).optional(),
  display_name: z.string().trim().min(1).max(32).optional(),
});
export type UserCreateInput = z.infer<typeof userCreateSchema>;

export const userPatchSchema = z
  .object({
    password: passwordSchema.optional(),
    role: z.enum(['ADMIN', 'MEMBER']).optional(),
    status: z.enum(['ACTIVE', 'DISABLED']).optional(),
    must_change_password: z.boolean().optional(),
    display_name: z.string().trim().min(1).max(32).nullable().optional(),
  })
  .refine((value) => Object.keys(value).length > 0, { message: '没有需要更新的字段' });
export type UserPatchInput = z.infer<typeof userPatchSchema>;
