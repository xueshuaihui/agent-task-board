import { http } from '@/api/client';
import type {
  Group,
  GroupCreateInput,
  GroupDeleteResult,
  GroupPatchInput,
} from './types';

/**
 * 0919 五章 `GET/POST /api/v1/groups`、`PATCH/DELETE /api/v1/groups/:id`。
 *
 * 暂不并入 `api/index.ts` 的 `api` 聚合对象：分组是 features/groups 的专属资源，
 * 查询 key 已在 `qk.groups()`（api/keys.ts）单点登记，WS 失效与缓存共享都靠它；
 * 等分组信息被更多 feature 读时再收编进聚合，迁移只是换 import。
 */
export const groupsApi = {
  /**
   * v0.0.4 W4 §16.2（r3）：`GET /groups` 服务端默认只回活跃分组；`{ archived: 'true' }`
   * 连归档组一起返回。前端 `useGroups` 固定取全量（归档折叠区、名字兜底都要读归档组），
   * 「活跃」由 `useActiveGroups` 在客户端过滤——语义与服务端口径一致。
   */
  list: (query?: { archived?: 'true' }) => http.get<{ items: Group[] }>('/groups', query),
  create: (body: GroupCreateInput) => http.post<Group>('/groups', body),
  patch: (id: string, body: GroupPatchInput) => http.patch<Group>(`/groups/${enc(id)}`, body),
  /**
   * v0.0.4 W4 §5.6：归档/反归档走专门端点（全部完成校验、默认组保护、恢复占额校验
   * 都在服务端；未通过时 409 + GROUP_NOT_ALL_DONE/GROUP_DEFAULT_PROTECTED/GROUP_LIMIT_REACHED）。
   */
  archive: (id: string) => http.post<Group>(`/groups/${enc(id)}/archive`),
  unarchive: (id: string) => http.post<Group>(`/groups/${enc(id)}/unarchive`),
  /** 5.1：删除前必须决定其下任务的去向——迁移到别的分组，或连同任务一并删除。 */
  remove: (id: string, query: { strategy: 'migrate' | 'cascade'; targetGroupId?: string }) =>
    http.del<GroupDeleteResult>(`/groups/${enc(id)}`, query),
};

/** 与 tasks.ts 的 `enc` 同一规则：路径参数原样透传、只做 URL 编码。 */
function enc(value: string): string {
  return encodeURIComponent(value);
}
