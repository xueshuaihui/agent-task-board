import { z } from 'zod';
import {
  appendLogSchema,
  blockedSchema,
  claimSchema,
  completeSchema,
  failSchema,
  heartbeatSchema,
  listReadyQuerySchema,
  progressSchema,
  reviewFeedbackQuerySchema,
  waitForResumeSchema,
} from '../contract/agent-schemas';
import { idLike } from '../contract/schemas';

export type ClaimInput = z.infer<typeof claimSchema>;
export type ListReadyInput = z.infer<typeof listReadyQuerySchema>;
export type LeaseTriple = z.infer<typeof heartbeatSchema>;
export type ProgressInput = z.infer<typeof progressSchema>;
export type AppendLogInput = z.infer<typeof appendLogSchema>;
export type CompleteInput = z.infer<typeof completeSchema>;
export type FailInput = z.infer<typeof failSchema>;
export type BlockedInput = z.infer<typeof blockedSchema>;
export type ReviewFeedbackInput = z.infer<typeof reviewFeedbackQuerySchema>;
export type WaitResumeInput = z.infer<typeof waitForResumeSchema>;

/** 12 章：`get_task` 是只读工具，不需要三元组（三元组只在写回侧强制）。 */
export const getTaskSchema = z.object({ task_id: idLike });
export type GetTaskInput = z.infer<typeof getTaskSchema>;

/** REST 的 `GET /tasks/{id}/review-feedback`：task_id 来自路径，查询串只剩 limit。 */
export const reviewFeedbackLimitSchema = reviewFeedbackQuerySchema.omit({ task_id: true });

export {
  appendLogSchema,
  blockedSchema,
  claimSchema,
  completeSchema,
  failSchema,
  heartbeatSchema,
  listReadyQuerySchema,
  progressSchema,
  reviewFeedbackQuerySchema,
  waitForResumeSchema,
};
