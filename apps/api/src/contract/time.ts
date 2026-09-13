/** 20.4：库内一律 `YYYY-MM-DD HH:MM:SS` 的 UTC 文本，接口出参 ISO‑8601 带 Z，入参接受 ISO 或日期。 */

const SQL_TIME_RE = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/;
const DATE_ONLY_RE = /^\d{4}-\d{2}-\d{2}$/;

export function nowSql(date: Date = new Date()): string {
  return date.toISOString().slice(0, 19).replace('T', ' ');
}

export function toSqlTime(input: string): string {
  if (SQL_TIME_RE.test(input)) return input;
  if (DATE_ONLY_RE.test(input)) return `${input} 00:00:00`;
  const parsed = new Date(input.includes('Z') || input.includes('+') ? input : `${input}Z`);
  if (Number.isNaN(parsed.getTime())) {
    throw new TypeError(`无法解析的时间：${input}`);
  }
  return nowSql(parsed);
}

/** 库里可能存进 date-only（due_at），出参保持原样，不硬造时分秒。 */
export function toIso(value: string | null | undefined): string | null {
  if (!value) return null;
  if (DATE_ONLY_RE.test(value)) return value;
  if (SQL_TIME_RE.test(value)) return `${value.replace(' ', 'T')}Z`;
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? value : parsed.toISOString();
}

/** `due_at` 存日期，其余时间列入库存 UTC 文本（20.4）。 */
export function toDateOnly(input: string): string {
  if (DATE_ONLY_RE.test(input)) return input;
  return toSqlTime(input).slice(0, 10);
}

export function isSqlTime(value: string): boolean {
  return SQL_TIME_RE.test(value);
}

export function durationMs(startedAtSql: string, finishedAtSql: string | null): number | null {
  if (!finishedAtSql) return null;
  const started = Date.parse(`${startedAtSql}Z`);
  const finished = Date.parse(`${finishedAtSql}Z`);
  if (Number.isNaN(started) || Number.isNaN(finished)) return null;
  return Math.max(0, finished - started);
}
