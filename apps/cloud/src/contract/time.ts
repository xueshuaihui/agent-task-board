/** 库内 `YYYY-MM-DD HH:MM:SS` UTC 文本，出参 ISO-8601 带 Z（与 apps/api 同口径）。 */
const SQL_TIME_RE = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/;

export function nowSql(date: Date = new Date()): string {
  return date.toISOString().slice(0, 19).replace('T', ' ');
}

export function toIso(value: string | null | undefined): string | null {
  if (!value) return null;
  if (!SQL_TIME_RE.test(value)) {
    const parsed = new Date(value);
    return Number.isNaN(parsed.getTime()) ? value : parsed.toISOString();
  }
  return `${value.replace(' ', 'T')}Z`;
}
