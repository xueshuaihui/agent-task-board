import { ApiException } from '../contract/errors';

/** 9.3：备份文件名用本地时间，秒级粒度。恢复接口的 `{name}` 就是它，所以它参与路径组装。 */
export const BACKUP_NAME_RE = /^atb-\d{8}-\d{6}\.db$/;

/** 6.12.1 / 13 章：导出文件名同一套时间戳规则。 */
export const EXPORT_NAME_RE = /^atb-export-\d{8}-\d{6}\.json$/;

function pad(value: number): string {
  return String(value).padStart(2, '0');
}

/** 本地时间戳：`backup_time` 与「上次备份 14:35」都是人看的钟点，不能用 UTC。 */
export function localStamp(date: Date = new Date()): string {
  return (
    `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}` +
    `-${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`
  );
}

export function backupNameAt(date: Date = new Date()): string {
  return `atb-${localStamp(date)}.db`;
}

export function exportNameAt(date: Date = new Date()): string {
  return `atb-export-${localStamp(date)}.json`;
}

/**
 * 13 章备份接口的白名单校验：组装路径**之前**判，不匹配直接 `INVALID_BACKUP_NAME`。
 * 分隔符与 `..` 单独列一遍不是多余的——正则已经挡了，但报错要能说明是哪一条。
 */
export function assertBackupName(name: string): string {
  if (typeof name !== 'string' || name === '') {
    throw new ApiException('INVALID_BACKUP_NAME', '备份文件名不能为空');
  }
  if (name.includes('/') || name.includes('\\') || name.includes('..')) {
    throw new ApiException('INVALID_BACKUP_NAME', '备份文件名不能包含路径分隔符');
  }
  if (!BACKUP_NAME_RE.test(name)) {
    throw new ApiException('INVALID_BACKUP_NAME', '备份文件名需匹配 atb-YYYYMMDD-HHmmss.db');
  }
  return name;
}

export function isBackupName(name: string): boolean {
  return BACKUP_NAME_RE.test(name);
}
