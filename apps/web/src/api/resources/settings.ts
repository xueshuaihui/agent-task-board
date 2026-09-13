import { http } from '../client';
import type { BackupListResult, Settings } from '../types';

/** 20.9 键总表 + 9.3 备份。**端口不在设置里**（10.3 三级决定，设置页不开放修改）。 */
export const settingsApi = {
  get: () => http.get<Settings>('/settings'),
  /** 未知 key 与越界值都是 422，`details[]` 逐 key 给原因。 */
  patch: (body: Partial<Settings>) => http.patch<Settings>('/settings', body),

  /** 9.3 立即备份。阶段一没有自动备份开关（17.2），也没有「来源」列。 */
  backup: () => http.post<{ name: string; size_bytes: number }>('/settings/backup'),
  /** 磁盘扫描、无 `backups` 表，按时间倒序；阶段一不删历史备份，故要显示总占用。 */
  backups: () => http.get<BackupListResult>('/settings/backups'),
  /** `{name}` 即磁盘文件名，服务端先校验 `^atb-\d{8}-\d{6}\.db$` 再组装路径。 */
  restore: (name: string) =>
    http.post<{ restored: string }>(`/settings/backups/${encodeURIComponent(name)}/restore`),
};
