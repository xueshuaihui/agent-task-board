import { http } from '../client';
import type {
  BatchResult,
  BatchTagsInput,
  BatchTransitionInput,
  BoardQuery,
  BoardResponse,
  Comment,
  CommentInput,
  DependenciesResult,
  DependencyCreateInput,
  LogLine,
  Page,
  ReviewsResult,
  RunsResult,
  TaskCard,
  TaskCreateInput,
  TaskDetail,
  TaskListItem,
  TaskListQuery,
  TaskPatchInput,
  TransitionInput,
  ReviewInput,
  StopInput,
} from '../types';

/** 20.7：board 是看板唯一数据源，六列一次返回、不分页；归档任务不出现。 */
export const boardApi = {
  get: (params?: BoardQuery) => http.get<BoardResponse>('/board', params),
};

/** 20.3：筛选器的标签候选，服务端 `SELECT DISTINCT` 实时聚合、不落表。 */
export const tagsApi = {
  list: () => http.get<{ tags: string[] }>('/tags'),
};

export const tasksApi = {
  /** 3.8 列表页：`page_size` 默认 50、上限 200，排序白名单见 `LIST_SORT_FIELDS`。 */
  list: (params?: TaskListQuery) => http.get<Page<TaskListItem>>('/tasks', params),
  create: (body: TaskCreateInput) => http.post<TaskDetail>('/tasks', body),
  /** 13 章路由顺序敏感：`tasks/batch/*` 必须能盖过 `tasks/:id`，前端拼路径时同理。 */
  batchTransition: (body: BatchTransitionInput) =>
    http.post<BatchResult>('/tasks/batch/transition', body),
  batchArchive: (body: { ids: string[] }) => http.post<BatchResult>('/tasks/batch/archive', body),
  batchTags: (body: BatchTagsInput) => http.post<BatchResult>('/tasks/batch/tags', body),

  detail: (id: string) => http.get<TaskDetail>(`/tasks/${enc(id)}`),
  patch: (id: string, body: TaskPatchInput) => http.patch<TaskDetail>(`/tasks/${enc(id)}`, body),
  /** 4.3.1 规则 4：`?force=true` 也不改变「RUNNING 不能删」的限制。 */
  remove: (id: string, force = false) =>
    http.del<{ id: string; deleted_runs: number; unblocked_ids: string[] }>(
      `/tasks/${enc(id)}`,
      force ? { force: true } : undefined,
    ),

  /** 4.5 拖拽矩阵：非法流转 → `409 ILLEGAL_TRANSITION`，message 即统一文案。 */
  transition: (id: string, body: TransitionInput) =>
    http.post<TaskDetail>(`/tasks/${enc(id)}/transition`, body),
  stop: (id: string, body: StopInput = {}) =>
    http.post<TaskDetail>(`/tasks/${enc(id)}/stop`, body),
  review: (id: string, body: ReviewInput) =>
    http.post<TaskDetail>(`/tasks/${enc(id)}/review`, body),
  pin: (id: string) => http.post<TaskCard>(`/tasks/${enc(id)}/pin`),
  unpin: (id: string) => http.del<TaskCard>(`/tasks/${enc(id)}/pin`),
  archive: (id: string) =>
    http.post<{ id: string; archived: true }>(`/tasks/${enc(id)}/archive`),
  restore: (id: string) => http.post<TaskCard>(`/tasks/${enc(id)}/restore`),
  addComment: (id: string, body: CommentInput) =>
    http.post<{ id: string }>(`/tasks/${enc(id)}/comments`, body),

  /* 抽屉各 Tab —— 13 章读取模型，缓存 key 见 `qk.taskTab` */
  runs: (id: string) => http.get<RunsResult>(`/tasks/${enc(id)}/runs`),
  reviews: (id: string) => http.get<ReviewsResult>(`/tasks/${enc(id)}/reviews`),
  dependencies: (id: string) =>
    http.get<DependenciesResult>(`/tasks/${enc(id)}/dependencies`),
  addDependency: (id: string, body: DependencyCreateInput) =>
    http.post<TaskDetail>(`/tasks/${enc(id)}/dependencies`, body),
  removeDependency: (id: string, depId: string) =>
    http.del<TaskDetail>(`/tasks/${enc(id)}/dependencies/${enc(depId)}`),
  comments: (id: string, params?: { type?: string[]; page?: number; page_size?: number }) =>
    http.get<Page<Comment>>(`/tasks/${enc(id)}/comments`, params),
};

export const runsApi = {
  /** `GET /runs/{id}/logs`：时间正序，界面「加载更早」= page 递增（13 章）。 */
  logs: (runId: string, params?: { page?: number; page_size?: number }) =>
    http.get<Page<LogLine>>(`/runs/${enc(runId)}/logs`, params),
};

/** 20.1：路径参数原样透传（服务端不做前缀校验，只查存在性），这里只做 URL 编码。 */
function enc(value: string): string {
  return encodeURIComponent(value);
}
