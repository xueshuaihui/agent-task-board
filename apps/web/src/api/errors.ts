import { COPY } from '@/lib/copy';
import type { ErrorCode, ValidationIssue } from './types';
import { ERROR_CODES } from './types';

/** 13 章统一错误体 `{ error: { code, message, ...上下文 } }` 的前端形态。 */
export class ApiError extends Error {
  readonly code: ErrorCode;
  /** 0 = 没拿到 HTTP 响应（sidecar 未起 / 正在重启）。 */
  readonly status: number;
  readonly details: unknown;
  /** 错误体里除 code/message/details 之外的上下文字段（task_id、run_id、task_count…）。 */
  readonly context: Record<string, unknown>;
  readonly method: string;
  readonly path: string;

  constructor(init: {
    code: ErrorCode;
    message: string;
    status?: number;
    details?: unknown;
    context?: Record<string, unknown>;
    method?: string;
    path?: string;
  }) {
    super(init.message);
    this.name = 'ApiError';
    this.code = init.code;
    this.status = init.status ?? 0;
    this.details = init.details;
    this.context = init.context ?? {};
    this.method = init.method ?? 'GET';
    this.path = init.path ?? '';
  }

  get isNetworkError(): boolean {
    return this.code === 'NETWORK_ERROR';
  }

  get userMessage(): string {
    return errorMessage(this);
  }
}

/**
 * 错误码 → 界面文案。服务端总会带 message，这张表服务两件事：
 * 1) 网络层错误（压根没响应）；2) 服务端 message 缺失时的兜底。
 * UI 要「按码分支」（比如 ILLEGAL_TRANSITION 弹提示、FIELD_IN_USE 引导停用）时判
 * `error.code`，不要匹配 message 字符串。
 */
export const ERROR_CODE_COPY: Record<ErrorCode, string> = {
  UNAUTHORIZED: '本地服务拒绝了本次请求：UI 会话 Token 缺失或不匹配',
  FORBIDDEN: '该凭证无权调用此接口',
  NOT_FOUND: '资源不存在或已被过滤',
  VALIDATION_FAILED: '有字段未通过校验',
  INVALID_PARAM: '参数不合法',
  ILLEGAL_TRANSITION: '该状态流转不被允许',
  TASK_NOT_RUNNING: '任务已不在执行中，无需停止',
  TASK_RUNNING: '任务正在执行，请先强制停止',
  TASK_GONE: '任务已被删除',
  ARCHIVE_BLOCKED_BY_DEPENDENCY: '该任务仍是其他未完成任务的前置，无法归档',
  DEPENDENCY_CYCLE: '依赖关系形成环，已取消保存',
  LEASE_EXPIRED: COPY.leaseExpired,
  LEASE_REVOKED: COPY.leaseRevoked,
  ARTIFACT_TOO_LARGE: '产物超过大小上限',
  ARTIFACT_LOST: COPY.artifactLost,
  IMPORT_ID_CONFLICT: '导入存在 ID 冲突，请选择处理策略',
  FIELD_IN_USE: '字段已被任务引用，不能删除',
  INVALID_BACKUP_NAME: '备份文件名不合法',
  GROUP_LIMIT_REACHED: '分组数量已达上限，先删除不用的分组',
  GROUP_DEFAULT_PROTECTED: '「默认」分组是任务的兜底归属，不可删除或归档',
  GROUP_NOT_ALL_DONE: '组内还有任务未完成或归档，全部处理完才能归档',
  GROUP_ARCHIVED: '该分组已归档，转为只读',
  BACKUP_NOT_FOUND: '备份文件已不在磁盘上',
  // v0.0.4 W7 §7.7：拆解动作与当前状态不匹配（confirm 需在「待确认」、cancel 需在接收/待确认）。
  BREAKDOWN_BAD_STATE: '拆解会话状态已变化，请刷新后重试',
  INTERNAL: '本地服务内部错误',
  NETWORK_ERROR: COPY.sidecarDown,
  UNKNOWN: '请求失败',
};

const CODE_SET = new Set<string>(ERROR_CODES);

export function isApiError(value: unknown): value is ApiError {
  return value instanceof ApiError;
}

export function errorCodeOf(value: unknown): ErrorCode | null {
  return isApiError(value) ? value.code : null;
}

export function isKnownErrorCode(value: string | undefined): value is ErrorCode {
  return !!value && CODE_SET.has(value);
}

/** 任意异常 → 可直接显示的一行文案；服务端 message 优先（4.5 文案由服务端单点产出）。 */
export function errorMessage(value: unknown): string {
  if (isApiError(value)) {
    const message = value.message?.trim();
    // 网络层错误与 5xx 的 message 是内部话术，一律换成面向用户的兜底文案。
    if (!message || value.code === 'NETWORK_ERROR' || value.status >= 500) {
      return ERROR_CODE_COPY[value.code];
    }
    return message;
  }
  if (value instanceof Error && value.message) return value.message;
  return ERROR_CODE_COPY.UNKNOWN;
}

/** VALIDATION_FAILED 的逐字段问题（13 章：`details[]`）。 */
export function validationIssues(error: unknown): ValidationIssue[] {
  if (!isApiError(error) || !Array.isArray(error.details)) return [];
  return (error.details as unknown[]).filter(
    (item): item is ValidationIssue => !!item && typeof item === 'object',
  );
}

/** 表单直接用：`{ severity: '需为数字' }`，键取 `path`，回落 `key`。 */
export function fieldErrorsOf(error: unknown): Record<string, string> {
  const map: Record<string, string> = {};
  for (const issue of validationIssues(error)) {
    const key = issue.path ?? issue.key;
    if (key && !map[key]) map[key] = issue.message ?? '取值不合法';
  }
  return map;
}

/** FIELD_IN_USE 的 `details.task_count`（UI 据此提示「改用停用」）等数值上下文。 */
export function contextNumber(error: unknown, name: string): number | null {
  if (!isApiError(error)) return null;
  const nested =
    error.details && typeof error.details === 'object'
      ? (error.details as Record<string, unknown>)[name]
      : undefined;
  const value = error.context[name] ?? nested;
  const parsed = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}
