import { http } from '../client';

/**
 * 前端偏好持久化（PRD 1.md 7.7）：GET/PUT /api/v1/prefs/:key，按账号一行一个 JSON value。
 * key 由前端自定（如 `board.grouping`），服务端不维护词表；PUT 整体覆盖。
 */
export const prefsApi = {
  get: (key: string) => http.get<{ key: string; value: unknown; updated_at: string | null }>(`/prefs/${encodeURIComponent(key)}`),
  put: (key: string, value: unknown) =>
    http.put<{ key: string; value: unknown; updated_at: string | null }>(`/prefs/${encodeURIComponent(key)}`, { value }),
};
