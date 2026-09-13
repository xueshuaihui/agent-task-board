import { z } from 'zod';

/**
 * 13 章 `POST /notifications/read`：`{ids:[]}` 或 `{all:true}`，两者都不给等于「什么都别标」，直接拒。
 *
 * 这里本地重写一份、不吃 contract 的 `markReadSchema`：它把 `ids` 按 `idLike`（≤24 位）校验，
 * 而 `notifications.id` 是 `newId()` 出的 UUID v7（36 位，20.1），照抄会让「按 id 标记已读」
 * 这个唯一用法每次请求都 422。长度放宽到 64，其余口径与 contract 一致；
 * contract 的 `idLike` 修好后这份可以删掉换回去。
 */
export const markReadBodySchema = z
  .object({
    ids: z.array(z.string().trim().min(3).max(64)).max(500).optional(),
    all: z.boolean().optional(),
  })
  .refine((value) => (value.ids?.length ?? 0) > 0 || value.all === true, {
    message: '需要 ids 或 all=true',
  });

export type MarkReadInput = z.infer<typeof markReadBodySchema>;
