import type { ReviewConclusion, ReturnTarget } from '@/api/types';

/**
 * 6.5 第 5 条：「表单草稿按任务存内存，切走再回来不丢」。
 *
 * 只存内存（Map，不落 localStorage）：草稿是半成品，跨进程重启后继续填一条
 * 可能已被别人改判的任务是负担；同一会话内的「抽屉→审核表单→取消→再打开」才是真实路径。
 * 所以这张表按 `taskId` 存，提交成功后 `clearDraft`。
 */
export interface ReviewDraft {
  conclusion: ReviewConclusion;
  suggestion: string;
  reason: string;
  detail: string;
  /** 20.2 `return_to` 默认 READY；仅驳回时随请求发出。 */
  returnTo: ReturnTarget;
  /** `undefined` = 不变（6.5：优先级调整只在驳回时出现，且是可选项）。 */
  priorityAdj?: number | undefined;
}

/**
 * 6.5 第 4 条：三字段去首尾空白后非空即可、无最短字数，**单字段 ≤ 2000 字、超出前端截断提示**。
 * 服务端 `reviewSchema` 的上限是 5000，取更严的 2000 由前端先把住（口径以 PRD 为准）。
 */
export const REVIEW_FIELD_MAX = 2000;

/** 6.5 第 4 条的必填口径：trim 后非空，不区分通过与驳回。 */
export const REQUIRED_FIELDS = ['suggestion', 'reason', 'detail'] as const;
export type RequiredField = (typeof REQUIRED_FIELDS)[number];

export const EMPTY_DRAFT: ReviewDraft = {
  conclusion: 'APPROVE',
  suggestion: '',
  reason: '',
  detail: '',
  returnTo: 'READY',
  priorityAdj: undefined,
};

const drafts = new Map<string, ReviewDraft>();

export function readDraft(taskId: string): ReviewDraft | null {
  return drafts.get(taskId) ?? null;
}

export function writeDraft(taskId: string, draft: ReviewDraft): void {
  drafts.set(taskId, draft);
}

export function clearDraft(taskId: string): void {
  drafts.delete(taskId);
}

/** 6.5 第 4 条：超长即截断，返回「截断后的值 + 是否发生了截断」。 */
export function clampField(value: string): { value: string; truncated: boolean } {
  if (value.length <= REVIEW_FIELD_MAX) return { value, truncated: false };
  return { value: value.slice(0, REVIEW_FIELD_MAX), truncated: true };
}

/** 本地必填校验：只挡空值，枚举与长度交服务端（原型 5.3「校验」行）。 */
export function missingRequiredFields(draft: ReviewDraft): RequiredField[] {
  return REQUIRED_FIELDS.filter((key) => draft[key].trim().length === 0);
}
