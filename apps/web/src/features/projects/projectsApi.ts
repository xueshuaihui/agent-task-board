import { http } from '@/api/client';
import type {
  Project,
  ProjectCreateInput,
  ProjectDeleteResult,
  ProjectPatchInput,
} from './types';

/**
 * 0919 五章 `GET/POST /api/v1/projects`、`PATCH/DELETE /api/v1/projects/:id`。
 *
 * 暂不并入 `api/index.ts` 的 `api` 聚合对象：项目是 features/projects 的专属资源，
 * 查询 key 已在 `qk.projects()`（api/keys.ts）单点登记，WS 失效与缓存共享都靠它；
 * 等项目信息被更多 feature 读时再收编进聚合，迁移只是换 import。
 */
export const projectsApi = {
  list: () => http.get<{ items: Project[] }>('/projects'),
  create: (body: ProjectCreateInput) => http.post<Project>('/projects', body),
  patch: (id: string, body: ProjectPatchInput) => http.patch<Project>(`/projects/${enc(id)}`, body),
  /** 5.1：删除前必须决定其下任务的去向——迁移到别的项目，或连同任务一并删除。 */
  remove: (id: string, query: { strategy: 'migrate' | 'delete'; targetProjectId?: string }) =>
    http.del<ProjectDeleteResult>(`/projects/${enc(id)}`, query),
};

/** 与 tasks.ts 的 `enc` 同一规则：路径参数原样透传、只做 URL 编码。 */
function enc(value: string): string {
  return encodeURIComponent(value);
}
