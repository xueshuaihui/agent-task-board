import { STATUS_LABEL, type TaskStatus, type UnknownEnumReport } from '../contract/enums';
import { toIso } from '../contract/time';

/**
 * `$queryRaw` 不做列名→模型字段的映射，读路径拿到的就是 tasks 表的原始列名。
 * 这里显式声明该形状，避免把 Prisma 的 camelCase 类型误用到原生 SQL 上。
 */
export interface TaskRawRow {
  id: string;
  type: string;
  title: string;
  description: string | null;
  status: string;
  priority: number;
  tags: string | null;
  required_capabilities: string | null;
  custom_fields: string | null;
  pinned: number;
  due_at: string | null;
  archived_at: string | null;
  lease_id: string | null;
  lease_expires_at: string | null;
  lease_revoked_at: string | null;
  stop_reason: string | null;
  current_run_id: string | null;
  claimed_at: string | null;
  run_count: number;
  created_at: string | null;
  updated_at: string | null;
  // 0919 账号/项目/父子扩展列（t.* 原样带回；测试造行可缺省）。
  skills?: string;
  account_id?: string;
  project_id?: string | null;
  parent_task_id?: string | null;
  sort_order?: number;
}

/** tasks 行 + 卡片需要的聚合列（当前 Run 的进度、阻塞数、产物数、上一次时长）。 */
export type TaskRow = TaskRawRow & {
  progress: number | null;
  progress_msg: string | null;
  agent_name: string | null;
  /** SQLite 的 COUNT() 经原生查询回来是 BigInt，不进 JSON 前先降回 number。 */
  blocked_count: number | bigint | null;
  artifact_count: number | bigint | null;
  last_run_duration_ms: number | bigint | null;
  /** 与 `last_run_duration_ms` 同一条 Run：RUNNING 时时长为 null，前端靠它算已进行时间。 */
  last_run_started_at: string | null;
};

export function toNum(value: number | bigint | null | undefined): number {
  return typeof value === 'bigint' ? Number(value) : (value ?? 0);
}

/** 与 0 语义不同的列（进度、时长）保留 null。 */
export function toNumOrNull(
  value: number | bigint | null | undefined,
): number | null {
  if (value === null || value === undefined) return null;
  return Number(value);
}

export const TASK_ROW_COLUMNS = `t.*, r.progress, r.progress_msg, r.agent_name,
  (SELECT COUNT(*) FROM task_dependencies d JOIN tasks dep ON dep.id = d.depends_on
    WHERE d.task_id = t.id AND d.type = 'blocks' AND dep.status != 'DONE') AS blocked_count,
  (SELECT COUNT(*) FROM artifacts a WHERE a.task_id = t.id) AS artifact_count,
  (SELECT x.duration_ms FROM task_runs x WHERE x.task_id = t.id ORDER BY x.run_number DESC LIMIT 1) AS last_run_duration_ms,
  (SELECT x.started_at FROM task_runs x WHERE x.task_id = t.id ORDER BY x.run_number DESC LIMIT 1) AS last_run_started_at`;

export interface CardArtifact {
  id: string;
  type: string;
  /** 20.7：不是数据库列，metadata.name 优先，否则取 uri 末段；link 无 name 时显示 host。 */
  name: string;
}

/**
 * 详情抽屉「执行记录」里的产物行（13 章读取模型）。
 *
 * `missing` 是 20.2/9.3/验收 42 要求的「产物区显示已丢失」标记：库里有一行、磁盘上没有文件
 * （备份不含产物目录，恢复后必然出现）。口径与产物元信息接口 `ArtifactMetaDto.missing` 同一条
 * ——`isArtifactMissing()`。契约：**文件在 = false**；`link` 不占磁盘，恒为 false。
 */
export interface RunArtifactDto {
  id: string;
  type: string;
  name: string;
  size_bytes: number | null;
  mime_type: string | null;
  created_at: string | null;
  missing: boolean;
}

export interface TaskCardDto {
  id: string;
  title: string;
  type: string;
  priority: number;
  tags: string[];
  pinned: boolean;
  status: TaskStatus;
  status_label: string;
  progress: number | null;
  progress_msg: string | null;
  lease_expires_at: string | null;
  agent_name: string | null;
  run_count: number;
  due_at: string | null;
  updated_at: string | null;
  project_id: string | null;
  blocked: { count: number; by: { id: string; title: string }[] };
  artifacts: CardArtifact[];
  artifact_count: number;
  custom_fields: Record<string, unknown>;
  /** 0919：子任务的父任务摘要（含父任务下子任务完成度）；无父任务为 null。 */
  parent?: { id: string; title: string; done: number; total: number } | null;
}

export interface TaskDetailDto extends TaskCardDto {
  description: string | null;
  required_capabilities: string[];
  current_run_id: string | null;
  stop_reason: string | null;
  archived_at: string | null;
  created_at: string | null;
  claimed_at: string | null;
  depends_on: { id: string; dep_id: string; title: string; status: TaskStatus; type: string }[];
  blocks: { id: string; dep_id: string; title: string; status: TaskStatus; type: string }[];
  /** 0919 10.3：技能绑定引用（[{skill_id, version}]），详情接口返回。 */
  skills: { skill_id: string; version?: string }[];
  /** 0919：父任务的需求才有：子任务列表与聚合进度/状态。 */
  children?: {
    id: string;
    title: string;
    type: string;
    status: TaskStatus;
    priority: number;
    sort_order: number;
  }[];
  aggregate?: { total: number; done: number; status: 'DONE' | 'BACKLOG' | 'IN_PROGRESS' } | null;
}

/** 聚合状态：全 DONE → DONE；全 BACKLOG → BACKLOG；其余一律 IN_PROGRESS。 */
export function aggregateStatus(statuses: string[]): 'DONE' | 'BACKLOG' | 'IN_PROGRESS' {
  if (statuses.length === 0) return 'BACKLOG';
  if (statuses.every((status) => status === 'DONE')) return 'DONE';
  if (statuses.every((status) => status === 'BACKLOG')) return 'BACKLOG';
  return 'IN_PROGRESS';
}

export function parseJsonArray(raw: string | null | undefined): string[] {
  if (!raw) return [];
  try {
    const value: unknown = JSON.parse(raw);
    return Array.isArray(value) ? value.map(String) : [];
  } catch {
    return [];
  }
}

export function parseJsonObject(raw: string | null | undefined): Record<string, unknown> {
  if (!raw) return {};
  try {
    const value: unknown = JSON.parse(raw);
    return value && typeof value === 'object' && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

/** 20.6：落盘文件名不含原始名，显示名从 metadata.name 或 uri 末段推导。 */
export function deriveArtifactName(
  metadata: Record<string, unknown>,
  uri: string,
  type: string,
): string {
  const named = metadata.name;
  if (typeof named === 'string' && named.trim() !== '') return named;
  if (type === 'link') {
    try {
      return new URL(uri).host;
    } catch {
      return uri;
    }
  }
  const last = uri.split('/').filter(Boolean).pop();
  return last ?? uri;
}

/**
 * `tasks.status` → 展示名。表外状态（历史库、手改数据）不给假标签也不抛：留空由界面按
 * `未知（原值）` 渲染——回落成 BACKLOG 会把库里的手改值显示成「需求池」，那是凭空造出来的
 * 第三个值（20.11）。同时把这条越界值经 `report` 交给服务端记 error 日志（20.2 末段、验收 43）。
 */
export function statusLabel(status: string, report?: UnknownEnumReport): string {
  const label = STATUS_LABEL[status as TaskStatus];
  if (label !== undefined) return label;
  report?.('tasks', 'status', status);
  return '';
}

/** tasks 行 + 聚合补充字段 → 卡片 DTO（20.7）。 */
export function toCardDto(
  row: TaskRow,
  extra: {
    blockedBy?: { id: string; title: string }[];
    artifacts?: CardArtifact[];
    cardFields?: Record<string, unknown>;
    parent?: { id: string; title: string; done: number; total: number } | null;
    /** 读到 20.2 表外枚举值时的上报口；不传则本函数保持纯函数、无副作用。 */
    reportUnknownEnum?: UnknownEnumReport;
  } = {},
): TaskCardDto {
  return {
    id: row.id,
    title: row.title,
    type: row.type,
    priority: toNum(row.priority),
    tags: parseJsonArray(row.tags),
    pinned: row.pinned === 1,
    status: row.status as TaskStatus,
    // 20.11：表外状态不给假标签，界面按 `未知（原值）` 渲染；服务端读路径同时记 error 日志。
    status_label: statusLabel(row.status, extra.reportUnknownEnum),
    progress: toNumOrNull(row.progress),
    progress_msg: row.progress_msg ?? null,
    lease_expires_at: toIso(row.lease_expires_at),
    agent_name: row.agent_name ?? null,
    run_count: toNum(row.run_count),
    due_at: row.due_at,
    updated_at: toIso(row.updated_at),
    blocked: {
      count: toNum(row.blocked_count),
      by: extra.blockedBy ?? [],
    },
    artifacts: extra.artifacts ?? [],
    artifact_count: toNum(row.artifact_count ?? extra.artifacts?.length),
    custom_fields: extra.cardFields ?? {},
    project_id: row.project_id ?? null,
    parent: extra.parent ?? null,
  };
}
