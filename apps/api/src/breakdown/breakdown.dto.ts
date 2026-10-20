import { z } from 'zod';

/**
 * GET /api/v1/breakdown/sessions 的 query 契约（#4 历史/归档过滤与分页）。
 *
 * `include_archived` 不能写 `z.coerce.boolean()`：查询串里的 "false" 是非空字符串，
 * coerce 会把它变成 true。与 data.dto.ts 的 multipart 布尔同一写法（union + transform），
 * 缺省 false。
 */
export const breakdownListQuerySchema = z.object({
  scope: z
    .enum(['active', 'history', 'all'])
    .optional()
    .describe('active=进行中（receiving/reviewing/creating）、history=历史（completed/cancelled/interrupted）、all=全部（默认）'),
  include_archived: z
    .union([z.boolean(), z.enum(['true', 'false', '1', '0'])])
    .default(false)
    .transform((value) => value === true || value === 'true' || value === '1')
    .describe('是否包含父需求已归档的会话，默认 false'),
  requirement_id: z.string().trim().max(64).optional().describe('按父需求任务 id 过滤'),
  limit: z.coerce.number().int().min(1).max(500).optional().describe('本页条数，默认 100，最大 500'),
  cursor: z.string().trim().min(1).max(64).optional().describe('上一页最后一条会话 id（keyset 分页）'),
});
export type BreakdownListQueryInput = z.infer<typeof breakdownListQuerySchema>;

/**
 * POST .../drafts/{ref}/regenerate 与 POST .../regenerate 的请求体（#4）。
 * body 整体可省略（兼容旧的无 body 调用）；note 是用户本次想改什么，trim 后 ≤2000 字。
 */
export const breakdownRegenerateBodySchema = z
  .object({
    note: z.string().trim().max(2000).optional().describe('重生成说明（≤2000 字），可省略'),
  })
  .optional();
export type BreakdownRegenerateBody = z.infer<typeof breakdownRegenerateBodySchema>;
