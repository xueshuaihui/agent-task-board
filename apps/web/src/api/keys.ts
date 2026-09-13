import type {
  AuditQuery,
  BoardQuery,
  CommentsQuery,
  TaskListQuery,
  TaskTab,
} from './types';

/**
 * query key 的唯一出处——**feature 里不要现写数组**。
 * 失效规则（`src/ws/invalidate.ts`）与 WS→invalidate 接线都靠这些前缀，
 * 现写 key 会让某个查询悄悄逃过失效，看板就出现「拖完不刷新」这类难查的问题。
 *
 * 命名规则：
 * - 读模型：`[资源名, 参数对象]`，参数缺省时给 `{}`（保证前缀长度稳定）。
 * - 详情抽屉：`['task', id, tab, ...局部参数]`（13 章读取模型）。`tab` 取 `TaskTab` 字面量，
 *   分页/单 Run 等局部参数一律跟在 `tab` 之后，于是 `invalidateQueries(['task', id, tab])`
 *   能一次清掉该 Tab 的全部分页缓存。
 * - `*Root` 常量只用于失效，不作为查询 key。
 */

type Params = Record<string, unknown>;

function withDefaults(params?: Params): Params {
  return params ?? {};
}

export const qk = {
  /** 20.7：view + 筛选参数整体进 key，切视图等于换查询。 */
  board: (params?: BoardQuery) => ['board', withDefaults(params as Params)] as const,
  boardRoot: ['board'] as const,

  /** 列表页（3.8）。 */
  tasks: (params?: TaskListQuery) => ['tasks', withDefaults(params as Params)] as const,
  tasksRoot: ['tasks'] as const,

  /** 抽屉：`['task', id]` 覆盖整抽屉，`['task', id, tab]` 覆盖单 Tab（13 章）。 */
  taskRoot: (id: string) => ['task', id] as const,
  task: (id: string) => ['task', id, 'overview'] as const,
  taskTab: (id: string, tab: TaskTab, ...rest: unknown[]) =>
    ['task', id, tab, ...rest] as const,
  taskRuns: (id: string) => ['task', id, 'runs'] as const,
  taskRunLogs: (id: string, runId: string, page: number) =>
    ['task', id, 'runs', runId, 'logs', { page }] as const,
  taskReviews: (id: string) => ['task', id, 'reviews'] as const,
  taskDependencies: (id: string) => ['task', id, 'dependencies'] as const,
  taskComments: (id: string, params?: CommentsQuery) =>
    ['task', id, 'comments', withDefaults(params as Params)] as const,
  taskAudit: (id: string, page = 1) => ['task', id, 'audit', { page }] as const,
  /** 所有任务级查询的根，删除任务时用。 */
  taskAny: ['task'] as const,

  tags: () => ['tags'] as const,

  notifications: (params?: { unread?: boolean }) =>
    ['notifications', withDefaults(params as Params)] as const,
  notificationsRoot: ['notifications'] as const,

  audit: (params?: AuditQuery) => ['audit', withDefaults(params as Params)] as const,
  auditRoot: ['audit'] as const,

  fieldDefs: () => ['field-defs'] as const,
  templates: () => ['templates'] as const,
  tokens: () => ['tokens'] as const,
  settings: () => ['settings'] as const,
  backups: () => ['backups'] as const,

  artifact: (id: string) => ['artifact', id] as const,
  artifactDiff: (id: string) => ['artifact', id, 'diff'] as const,
  artifactRoot: ['artifact'] as const,
} as const;
