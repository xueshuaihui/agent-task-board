/**
 * 数据访问的唯一入口：feature 里 `import { api, qk } from '@/api'`，不要直接 import `fetch`
 * 也不要绕过 `qk` 现写 query key。
 */
import { artifactsApi } from './resources/artifacts';
import { auditApi } from './resources/audit';
import { breakdownApi } from './resources/breakdown';
import { dataApi } from './resources/data';
import { fieldDefsApi } from './resources/field-defs';
import { notificationsApi } from './resources/notifications';
import { prefsApi } from './resources/prefs';
import { settingsApi } from './resources/settings';
import { tasksApi, boardApi, runsApi, tagsApi } from './resources/tasks';
import { templatesApi } from './resources/templates';
import { tokensApi } from './resources/tokens';

export const api = {
  board: boardApi,
  tags: tagsApi,
  tasks: tasksApi,
  runs: runsApi,
  fieldDefs: fieldDefsApi,
  templates: templatesApi,
  tokens: tokensApi,
  settings: settingsApi,
  notifications: notificationsApi,
  audit: auditApi,
  artifacts: artifactsApi,
  data: dataApi,
  prefs: prefsApi,
  breakdown: breakdownApi,
} as const;

export { http, buildQuery, requestUrl } from './client';
export type { DownloadResult, QueryLike, QueryParams, RequestOptions } from './client';
export {
  ApiError,
  ERROR_CODE_COPY,
  contextNumber,
  errorCodeOf,
  errorMessage,
  fieldErrorsOf,
  isApiError,
  isKnownErrorCode,
  validationIssues,
} from './errors';
export { apiBase, apiUrl, hasUiToken, setUiToken, uiToken, wsUrl } from './env';
export { qk } from './keys';
export { artifactSrc } from './resources/artifacts';
export * from './queries';
export * from './mutations';
export type * from './types';
