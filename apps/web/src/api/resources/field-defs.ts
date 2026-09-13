import { http } from '../client';
import type { FieldDef, FieldDefCreateInput, FieldDefPatchInput } from '../types';

/** 13 章「自定义字段接口」：全部只吃 UI 凭证。 */
export const fieldDefsApi = {
  list: () => http.get<{ items: FieldDef[] }>('/field-defs'),
  create: (body: FieldDefCreateInput) => http.post<FieldDef>('/field-defs', body),
  /** PATCH 里出现 `key`/`type` 一律 422（两者保存后不可变：改 key 等于换字段）。 */
  patch: (id: string, body: FieldDefPatchInput) =>
    http.patch<FieldDef>(`/field-defs/${enc(id)}`, body),
  /** 被任务引用 → `409 FIELD_IN_USE` + `details.task_count`，UI 据此引导「改用停用」。 */
  remove: (id: string) => http.del<{ id: string }>(`/field-defs/${enc(id)}`),
};

function enc(value: string): string {
  return encodeURIComponent(value);
}
