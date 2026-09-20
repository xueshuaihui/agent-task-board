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
  list: () => http.get<{ items: Group[] }>('/groups'),
  create: (body: GroupCreateInput) => http.post<Group>('/groups', body),
  patch: (id: string, body: GroupPatchInput) => http.patch<Group>(`/groups/${enc(id)}`, body),
  /** 5.1：删除前必须决定其下任务的去向——迁移到别的分组，或连同任务一并删除。 */
  remove: (id: string, query: { strategy: 'migrate' | 'cascade'; targetGroupId?: string }) =>
    http.del<GroupDeleteResult>(`/groups/${enc(id)}`, query),
};

/** 与 tasks.ts 的 `enc` 同一规则：路径参数原样透传、只做 URL 编码。 */
function enc(value: string): string {
  return encodeURIComponent(value);
}
