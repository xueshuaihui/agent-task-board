import { http } from '../client';
import type { AuditEntry, AuditQuery, Page } from '../types';

/** 4.10 / 7.7：审计只有 target 过滤，`page_size` 固定 50、时间倒序，无其他筛选（17.2）。 */
export const auditApi = {
  list: (params?: AuditQuery) => http.get<Page<AuditEntry>>('/audit', params),
};
