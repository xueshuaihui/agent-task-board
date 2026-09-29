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
  // 0020 §3.3/Q4：自审硬门禁（审核者 Token == 被审 Run 的执行者 Token）。
  SELF_REVIEW_FORBIDDEN: '不能自己审核自己产生的执行记录，请换另一个 Agent 凭证提交审核',
  NOT_FOUND: '资源不存在或已被过滤',
  VALIDATION_FAILED: '有字段未通过校验',
  INVALID_PARAM: '参数不合法',
  ILLEGAL_TRANSITION: '该状态流转不被允许',
  TASK_NOT_RUNNING: '任务已不在执行中，无需停止',
  TASK_RUNNING: '任务正在执行，请先强制停止',
  TASK_GONE: '任务已被删除',
  // §16.1：停在 BLOCKED/REVIEW/DONE/FAILED——服务端 message 会指名该走哪条链路，这里只兜底。
  TASK_NOT_EDITABLE: '任务当前状态不在可编辑窗口内（已阻塞、待审核、已完成或已失败）',
  ARCHIVE_BLOCKED_BY_DEPENDENCY: '该任务仍是其他未完成任务的前置，无法归档',
  DEPENDENCY_CYCLE: '依赖关系形成环，已取消保存',
  LEASE_EXPIRED: COPY.leaseExpired,
  LEASE_REVOKED: COPY.leaseRevoked,
  ARTIFACT_TOO_LARGE: '产物超过大小上限',
  ARTIFACT_LOST: COPY.artifactLost,
  IMPORT_ID_CONFLICT: '导入存在 ID 冲突，请选择处理策略',
  FIELD_IN_USE: '字段已被任务引用，不能删除',
  // 8 章技能管理
  SKILL_BOUND: '该技能已被任务引用，不能删除',
  SKILL_ID_CONFLICT: '已存在同 ID 的技能，请选择覆盖或跳过',
  SKILL_READONLY: '内置技能不可修改、删除或发版本',
  SKILL_REF_SELF: '技能不能引用自己',
  SKILL_REF_CYCLE: '技能引用形成了环，已取消保存',
  INVALID_BACKUP_NAME: '备份文件名不合法',
  // §19.15·90（r6 R3-D）：分组在 web 已无管理入口，这三条兜底文案改为陈述性口径、
  // 不再承诺「去分组页做某事」这类 UI 操作（实际可达面只有 REST/Agent）。
  GROUP_LIMIT_REACHED: '活跃分组数量已达服务端上限，该约束仅在 REST/Agent 面处理（界面已无分组管理入口）',
  GROUP_DEFAULT_PROTECTED: '「默认」分组是服务端兜底归属的数据层占位，不随界面操作变化',
  GROUP_NOT_ALL_DONE: '组内还有任务未完成或归档，全部处理完才能归档',
  GROUP_ARCHIVED: '该任务所属分组处于归档只读状态（分组状态仅 REST/Agent 面可变更）',
  BACKUP_NOT_FOUND: '备份文件已不在磁盘上',
  // v0.0.4 W7 §7.7：拆解动作与当前状态不匹配（confirm 需在「待确认」、cancel 需在接收/待确认）。
  BREAKDOWN_BAD_STATE: '拆解会话状态已变化，请刷新后重试',
  // v0.0.4 W7 遗留 b3 §7.4：显式带的 ref 在会话内已占用。
  BREAKDOWN_DRAFT_REF_TAKEN: '该编号在本次拆解会话里已被占用，请换一个',
  // v0.0.4 W8 §8.7 r3：卡片终态就地收口用（界面自己出文案，不走通用 Toast），兜底给一行说明。
  CREATION_REQUEST_RESOLVED: '该创建请求已终结，决策未生效',
  // 8.8：本期不实现的远程技能源。
  NOT_IMPLEMENTED: '这一能力本期未实现',
  // ── 数据层七枚（2026-09-29「报错全部细化」）：正常路径下服务端 message 已经带了动作指引
  //    （contract/db-errors.ts 逐条写的），这里只在 message 缺失时兜底，口径保持一致。
  DATA_STILL_REFERENCED: '这条数据还被其他数据引用着，删不掉',
  DATA_DUPLICATE: '这个值已经被另一条记录占用了，请改一个',
  SCHEMA_MISMATCH: '本地数据库结构与程序版本不一致，通常是升级后迁移没跑完，请重启本地服务',
  STORAGE_UNAVAILABLE: '本地数据库暂时不可用，请检查数据目录（是否被移动、外接盘是否拔出）后重试',
  STORAGE_LOCKED: '本地数据库正被另一个进程占用，请稍后重试',
  STORAGE_CORRUPT: '本地数据库文件已损坏，请从备份恢复',
  STORAGE_READONLY: '本地数据目录当前不可写，请检查目录权限或所在磁盘',
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

/**
 * 服务端「什么都没解出来」时只会下发这一句通用文案（`contract/db-errors.ts` 的兜底分支）。
 * 判据用它，而不是「status >= 500 一律换文案」。
 */
const GENERIC_SERVER_COPY = new Set(['服务内部错误', '内部错误', 'Internal Server Error']);

/** 任意异常 → 可直接显示的一行文案；服务端 message 优先（4.5 文案由服务端单点产出）。 */
export function errorMessage(value: unknown): string {
  if (isApiError(value)) {
    const message = value.message?.trim();
    // 网络层错误没有服务端文案可用，只能本地兜。
    if (!message || value.code === 'NETWORK_ERROR') return ERROR_CODE_COPY[value.code];
    // 2026-09-29 拍板②：5xx 不再一刀切换成码表文案。数据层细化之后，500/503 的 message 本身
    // 就是「现在怎么办」（库损坏→从备份恢复、缺列→重启本地服务、只读目录→查权限），
    // 老规则把服务端那句扔掉、换成「本地服务内部错误」，等于把唯一的有用信息抹掉。
    // 只有服务端确实没给信息（通用兜底句）时才回落到本地码表。
    if (GENERIC_SERVER_COPY.has(message)) return ERROR_CODE_COPY[value.code];
    return message;
  }
  if (value instanceof Error && value.message) return value.message;
  return ERROR_CODE_COPY.UNKNOWN;
}

/**
 * 折叠区那一行：`context.detail`（引擎原文，服务端已收口成一行、截到 220 字）。
 * 与 `errorMessage` 的分工：上面那句给用户看「怎么办」，这句给排障的人看「到底怎么了」。
 * 返回 undefined 时不显示折叠入口——不是每条错误都有技术细节。
 */
export function errorDetailOf(value: unknown): string | undefined {
  if (!isApiError(value)) return undefined;
  const detail = value.context.detail ?? value.context.cause;
  const text = typeof detail === 'string' ? detail.trim() : '';
  return text.length > 0 && text !== value.message.trim() ? text : undefined;
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
