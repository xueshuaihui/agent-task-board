/**
 * 20.4 时间契约：库里 UTC，接口出参一律 ISO‑8601 带 `Z`（`due_at` 是 `YYYY-MM-DD` 例外），
 * 前端只消费 ISO 串、按本地时区显示，不做任何时区猜测。
 */

const DATE_ONLY_RE = /^\d{4}-\d{2}-\d{2}$/;

export function parseIso(value: string | null | undefined): Date | null {
  if (!value) return null;
  const parsed = new Date(DATE_ONLY_RE.test(value) ? `${value}T00:00:00` : value);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

function pad(value: number): string {
  return value < 10 ? `0${value}` : String(value);
}

/** 绝对时间：本地时区，`2026-09-11 23:00`。 */
export function formatDateTime(value: string | null | undefined): string {
  const date = parseIso(value);
  if (!date) return '—';
  if (DATE_ONLY_RE.test(String(value))) return `${value}`;
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

/** 仅日期（due_at 用，按本地日解读）。 */
export function formatDate(value: string | null | undefined): string {
  const date = parseIso(value);
  return date
    ? `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`
    : '—';
}

/** 相对时间：距今 24 小时内给相对值，之外退回绝对日期（原型 3.3、3.8）。 */
export function formatRelative(value: string | null | undefined, now: number = Date.now()): string {
  const date = parseIso(value);
  if (!date) return '—';
  const delta = now - date.getTime();
  if (delta < 0) return formatDateTime(value);
  const minutes = Math.floor(delta / 60_000);
  if (minutes < 1) return '刚刚';
  if (minutes < 60) return `${minutes} 分钟前`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} 小时前`;
  const days = Math.floor(hours / 24);
  if (days === 1) return '昨天';
  if (days < 30) return `${days} 天前`;
  return formatDate(value);
}

/** 时长：`duration_ms` 整数毫秒（20.4），列表页与 Run 行共用。 */
export function formatDuration(ms: number | null | undefined): string {
  if (ms === null || ms === undefined) return '—';
  if (ms < 1000) return `${ms}ms`;
  const seconds = Math.floor(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return rest === 0 ? `${hours}h` : `${hours}h ${rest}m`;
}

/** 文件大小：20.4 要求 B/KB/MB、1 位小数。 */
export function formatBytes(bytes: number | null | undefined): string {
  if (bytes === null || bytes === undefined) return '—';
  if (bytes < 1024) return `${bytes} B`;
  const kb = bytes / 1024;
  if (kb < 1024) return `${kb.toFixed(1)} KB`;
  return `${(kb / 1024).toFixed(1)} MB`;
}

/**
 * 租约倒计时：前端用本地时钟与 `lease_expires_at` 相减（20.4）。
 * 归零不代表已回收——回收只在服务端定时任务里发生（9.3），所以调用方拿到 expired=true
 * 时要把倒计时变红并等 WS `lease.expired`，不要自行改状态。
 */
export function leaseRemaining(
  expiresAt: string | null | undefined,
  now: number = Date.now(),
): { text: string; expired: boolean; remainingMs: number } {
  const date = parseIso(expiresAt);
  if (!date) return { text: '—', expired: false, remainingMs: 0 };
  const remaining = date.getTime() - now;
  if (remaining <= 0) return { text: '00:00', expired: true, remainingMs: 0 };
  const minutes = Math.floor(remaining / 60_000);
  const seconds = Math.floor((remaining % 60_000) / 1000);
  return { text: `${pad(minutes)}:${pad(seconds)}`, expired: false, remainingMs: remaining };
}

/** 入参给服务端的时间：一律 ISO（服务端归一为库内 UTC 文本）。 */
export function toIsoInput(date: Date): string {
  return date.toISOString();
}
