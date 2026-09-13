import { apiBase, apiUrl, hasUiToken, uiToken } from './env';
import { ApiError } from './errors';
import type { ApiErrorBody, ErrorCode } from './types';

export type HttpMethod = 'GET' | 'POST' | 'PATCH' | 'DELETE' | 'PUT';

export interface QueryParams {
  [key: string]: unknown;
}

/**
 * 调用方传进来的查询对象。刻意不是 `QueryParams`：TS 不给 `interface` 隐式索引签名，
 * 于是 `BoardQuery` / `TaskListQuery` 这些具名查询类型会撞在 `Record<string, unknown>` 门外。
 * 序列化只走 `Object.entries`，对形状没有要求——约束由各资源的 `*Query` 接口负责。
 */
export type QueryLike = QueryParams | object;

export interface RequestOptions {
  query?: QueryLike;
  body?: unknown;
  signal?: AbortSignal;
  headers?: Record<string, string>;
}

/**
 * 查询串序列化：
 * - 数组 → 重复键（后端 `stringListSchema` 同时吃重复键与逗号串，13 章）；
 * - `custom_fields: { severity: '高' }` → `custom_fields[severity]=高`（20.7 的键形态）；
 * - `undefined` / `null` / 空数组 → 不发送，让服务端走默认值（`archived=false` 等）。
 */
export function buildQuery(params?: QueryLike): string {
  if (!params) return '';
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params as QueryParams)) {
    appendParam(search, key, value);
  }
  const encoded = search.toString();
  return encoded ? `?${encoded}` : '';
}

function appendParam(search: URLSearchParams, key: string, value: unknown): void {
  if (value === undefined || value === null || value === '') return;
  if (Array.isArray(value)) {
    for (const item of value) appendParam(search, key, item);
    return;
  }
  if (typeof value === 'object') {
    for (const [inner, item] of Object.entries(value as QueryParams)) {
      // 方括号键：Express 5 需要 app.set('query parser','extended')，后端已就位。
      appendParam(search, `${key}[${inner}]`, item);
    }
    return;
  }
  search.append(key, String(value));
}

export function requestUrl(path: string, query?: QueryLike): string {
  return apiUrl(`${API_PREFIX}${path}${buildQuery(query)}`);
}

/** 13 章：所有业务接口都在 `/api/v1` 下，根路径 404（9.4.4），所以这里集中拼前缀。 */
const API_PREFIX = '/api/v1';

export interface RequestFailureHandlers {
  (error: ApiError): void;
}

const unauthorizedListeners = new Set<RequestFailureHandlers>();

/** Token 不匹配（401）时 sidecar 已被重启过，壳层据此提示而不是让每个页面各自静默失败。 */
export function onUnauthorized(listener: RequestFailureHandlers): () => void {
  unauthorizedListeners.add(listener);
  return () => unauthorizedListeners.delete(listener);
}

function notifyUnauthorized(error: ApiError): void {
  for (const listener of unauthorizedListeners) listener(error);
}

/** 13 章「认证」：UI 会话 Token 只走 `Authorization: Bearer`，不进查询参数。 */
function authHeaders(extra?: Record<string, string>): Record<string, string> {
  return { Accept: 'application/json', ...extra, Authorization: `Bearer ${uiToken()}` };
}

async function send(
  method: HttpMethod,
  path: string,
  options: RequestOptions = {},
): Promise<Response> {
  if (!hasUiToken()) {
    throw new ApiError({
      code: 'UNAUTHORIZED',
      message:
        '未取到 UI 会话 Token：开发态请先以 ATB_DEV=1 起 sidecar（会写 <dataDir>/dev-ui-token）再重启 vite；生产态由 Tauri 主进程注入。',
      method,
      path,
    });
  }
  const url = `${apiBase()}${API_PREFIX}${path}${buildQuery(options.query)}`;
  const isJsonBody = options.body !== undefined && !(options.body instanceof FormData);
  let response: Response;
  try {
    response = await fetch(url, {
      method,
      headers: authHeaders({
        ...(isJsonBody ? { 'Content-Type': 'application/json' } : {}),
        ...options.headers,
      }),
      body: isJsonBody ? JSON.stringify(options.body) : (options.body as FormData | undefined),
      signal: options.signal,
      credentials: 'omit',
    });
  } catch (cause) {
    if (cause instanceof DOMException && cause.name === 'AbortError') throw cause;
    // 连不上 = sidecar 没起或正在重启（2.3「重启服务」期间），托盘与 Toast 都按这个码提示。
    throw new ApiError({
      code: 'NETWORK_ERROR',
      message: (cause as Error)?.message ?? '无法连接本地服务',
      context: { cause: String(cause) },
      method,
      path,
    });
  }
  return response;
}

async function toApiError(response: Response, method: HttpMethod, path: string): Promise<ApiError> {
  let body: ApiErrorBody | null = null;
  try {
    body = (await response.json()) as ApiErrorBody;
  } catch {
    body = null;
  }
  const error = body?.error;
  const known = (error?.code ?? '') as ErrorCode;
  const context: Record<string, unknown> = {};
  if (error) {
    for (const [key, value] of Object.entries(error)) {
      if (key !== 'code' && key !== 'message' && key !== 'details') context[key] = value;
    }
  }
  const fallback: Record<number, ErrorCode> = {
    401: 'UNAUTHORIZED',
    403: 'FORBIDDEN',
    404: 'NOT_FOUND',
    409: 'ILLEGAL_TRANSITION',
    410: 'LEASE_EXPIRED',
    413: 'ARTIFACT_TOO_LARGE',
    422: 'VALIDATION_FAILED',
  };
  return new ApiError({
    code: typeof error?.code === 'string' && error.code.length > 0 ? known : (fallback[response.status] ?? 'UNKNOWN'),
    message: error?.message ?? `HTTP ${response.status}`,
    status: response.status,
    details: error?.details,
    context,
    method,
    path,
  });
}

/** JSON 接口：非 2xx 一律抛 ApiError（13 章错误体解析成 typed error）。 */
export async function request<T>(
  method: HttpMethod,
  path: string,
  options: RequestOptions = {},
): Promise<T> {
  const response = await send(method, path, options);
  if (response.status === 204) return undefined as T;
  if (!response.ok) {
    const error = await toApiError(response, method, path);
    if (error.status === 401) notifyUnauthorized(error);
    throw error;
  }
  const text = await response.text();
  if (text === '') return undefined as T;
  try {
    return JSON.parse(text) as T;
  } catch {
    // 拿到 HTML 说明打到了非 /api 路径（根路径 404，验收 2）——不要静默当成空数据。
    throw new ApiError({
      code: 'UNKNOWN',
      message: `响应不是合法 JSON（${method} ${path}）`,
      status: response.status,
      method,
      path,
    });
  }
}

export interface DownloadResult {
  blob: Blob;
  filename: string;
}

/** 6.12.1 导出：`Content-Type: application/json` 附件流，前端拿 Blob 落地。 */
export async function download(
  method: HttpMethod,
  path: string,
  options: RequestOptions = {},
): Promise<DownloadResult> {
  const response = await send(method, path, options);
  if (!response.ok) throw await toApiError(response, method, path);
  const disposition = response.headers.get('Content-Disposition') ?? '';
  const match = /filename\*?=(?:UTF-8''")?([^";]+)/i.exec(disposition);
  return {
    blob: await response.blob(),
    filename: match ? decodeURIComponent(match[1].replace(/"/g, '')) : 'atb-export.json',
  };
}

export const http = {
  get: <T>(path: string, query?: QueryLike, signal?: AbortSignal) =>
    request<T>('GET', path, { query, signal }),
  post: <T>(path: string, body?: unknown, query?: QueryLike) =>
    request<T>('POST', path, { body, query }),
  patch: <T>(path: string, body?: unknown, query?: QueryLike) =>
    request<T>('PATCH', path, { body, query }),
  del: <T>(path: string, query?: QueryLike) => request<T>('DELETE', path, { query }),
  put: <T>(path: string, body?: unknown) => request<T>('PUT', path, { body }),
  form: <T>(path: string, form: FormData) => request<T>('POST', path, { body: form }),
  download,
  url: requestUrl,
};
