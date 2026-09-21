import { http } from '../client';
import type { CreationDecisionInput, CreationRequestView } from '../types';

/**
 * v0.0.4 W8 §8.7 r3「creation-requests」两行 UI 面端点（PRD §16.2 表）：
 *   GET  /creation-requests              待决 + 近期终结项列表（断线重连补卡片的数据源）
 *   POST /creation-requests/{id}/decision  用户决策 create / edit / cancel
 * 卡片本体主要由 WS `agent.task_requested` 下发；这里的 GET 只补断线期间漏掉的那几张。
 * POST /creation-requests（REST 侧生成请求）是给 Agent/联调用的，界面不自建待决请求，故不接。
 */
function enc(id: string): string {
  return encodeURIComponent(id);
}

export const creationApi = {
  list: () => http.get<CreationRequestView[]>('/creation-requests'),

  /** 决策成功回最新视图（含 task_id）；已终结/过宽限 → 409 `CREATION_REQUEST_RESOLVED`。 */
  decide: (id: string, body: CreationDecisionInput) =>
    http.post<CreationRequestView>(`/creation-requests/${enc(id)}/decision`, body),
};
