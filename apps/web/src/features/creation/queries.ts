import { useQuery } from '@tanstack/react-query';
import type { UseQueryOptions } from '@tanstack/react-query';
import { api, qk } from '@/api';
import type { CreationRequestView } from '@/api/types';

/**
 * v0.0.4 W8 §8.7 读侧：轻确认请求列表。
 *
 * 卡片数据源是 WS `agent.task_requested`（进 `store.ts`），这条 GET 只干一件事——
 * **断线重连补齐漏掉的未决卡片**（13 章「断线期间事件不补发」，故 `refreshAfterReconnect`
 * 会失效 `qk.creationRoot` 触发重取，见 src/ws/invalidate.ts）。
 * 因此它挂在全局宿主上、`staleTime` 给足，不参与卡片的终态推进。
 */
export function useCreationRequests(options?: Partial<UseQueryOptions<CreationRequestView[], Error>>) {
  return useQuery({
    queryKey: qk.creationRequests(),
    queryFn: () => api.creation.list(),
    staleTime: 60_000,
    ...options,
  });
}

/** 决策请求：create / edit（带修改后载荷）/ cancel。409 由调用方就地收口，不弹通用 Toast。 */
export function decideCreationRequest(
  requestId: string,
  body: Parameters<typeof api.creation.decide>[1],
): Promise<CreationRequestView> {
  return api.creation.decide(requestId, body);
}
