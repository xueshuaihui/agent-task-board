import { z } from 'zod';

export const usernameSchema = z
  .string()
  .trim()
  .regex(/^[a-zA-Z0-9_-]{3,32}$/, '用户名需为 3-32 位字母/数字/下划线/连字符');

export const passwordSchema = z.string().min(6).max(64);

export const registerSchema = z.object({
  username: usernameSchema,
  password: passwordSchema,
  display_name: z.string().trim().min(1).max(32).optional(),
});
export type RegisterInput = z.infer<typeof registerSchema>;

export const loginSchema = z.object({
  username: usernameSchema,
  password: z.string().min(1).max(128),
});
export type LoginInput = z.infer<typeof loginSchema>;
