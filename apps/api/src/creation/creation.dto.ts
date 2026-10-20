import { z } from 'zod';
import { createTaskSchema } from '../contract/agent-schemas';
import { REVIEW_MODES } from '../contract/enums';

/**
 * v0.0.4 W8-a2 §16.2「creation-requests」两写端点的入参契约。
 * 字段词表与 board.create_task 同源（直接取 createTaskSchema.shape 复用，避免两份漂移）。
 */
const s = createTaskSchema.shape;

/** POST /creation-requests：生成待决创建请求（轻确认卡片数据源之一，r3）。 */
export const creationRequestCreateSchema = z.object({
  title: s.title,
  description: s.description,
  group_id: s.group_id,
  type: s.type,
  priority: s.priority,
  tags: s.tags,
  skills: s.skills,
  parent_task_id: s.parent_task_id,
  requested_review_mode: s.requested_review_mode,
  // REST/UI 面可以直接指定拟用审核方式（用户是唯一能落 review_mode 的一方）；
  // Agent 的 MCP 面没有这个键，只能走 requested_review_mode 请求。
  review_mode: z.enum(REVIEW_MODES).optional(),
  // REST 入口可能没有会话上下文（session_id 在 create_task 是必填记账键，这里降级可选）。
  session_id: s.session_id.optional().nullable(),
  agent_name: s.agent_name,
});
export type CreationRequestCreateInput = z.infer<typeof creationRequestCreateSchema>;

/**
 * POST /creation-requests/{id}/decision（§8.7 r3）：create / edit / cancel，
 * edit 必带修改后载荷——只允许覆盖任务内容字段，请求身份（agent/session）不可改。
 */
export const creationDecisionSchema = z
  .object({
    action: z.enum(['create', 'edit', 'cancel']),
    payload: z
      .object({
        title: s.title,
        description: s.description,
        group_id: s.group_id,
        type: s.type,
        priority: s.priority,
        tags: s.tags,
        skills: s.skills,
        parent_task_id: s.parent_task_id,
        // 用户决策是唯一能落 review_mode 的地方（Agent 只能请求、不能决定）。
        review_mode: z.enum(REVIEW_MODES).optional(),
      })
      .partial()
      .optional(),
  })
  .superRefine((value, ctx) => {
    if (value.action === 'edit' && !value.payload) {
      ctx.addIssue({ code: 'custom', path: ['payload'], message: 'edit 决策必须携带修改后载荷（§8.7）' });
    }
    if (value.action !== 'edit' && value.payload) {
      ctx.addIssue({ code: 'custom', path: ['payload'], message: '仅 edit 决策携带修改后载荷（§8.7）' });
    }
  });
export type CreationDecisionInput = z.infer<typeof creationDecisionSchema>;
