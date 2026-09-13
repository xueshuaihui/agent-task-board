import { QueryClient } from '@tanstack/react-query';
import { ApiError } from '@/api/errors';

/**
 * 缓存策略的唯一出处：feature 里不要再各写 retry / refetchOnWindowFocus。
 *
 * - 4xx 一律不重试：`ILLEGAL_TRANSITION`、`UNAUTHORIZED` 重放只会再失败一次，还会把
 *   同一条 Toast 弹两遍。
 * - 网络层失败（`status === 0`，sidecar 未起或正在重启，见 api/client.ts）只重试一次：
 *   托盘「重启服务」通常 1~2 秒内恢复，一次重试能把「点了没反应」挡在界面外。
 * - `refetchOnWindowFocus: false`：13 章把 WS 定为一等失效信号，窗口每次得焦点就重拉
 *   `/board` 等于用本地进程的请求量换一次列表闪动。
 * - `staleTime` 给 3 秒：只用来合并同一帧内多个组件挂载同一 key 的重复请求。
 */
export function createQueryClient(): QueryClient {
  return new QueryClient({
    defaultOptions: {
      queries: {
        retry: (failureCount, error) => {
          if (error instanceof ApiError && error.isNetworkError) return failureCount < 1;
          return false;
        },
        retryDelay: 500,
        refetchOnWindowFocus: false,
        staleTime: 3_000,
        gcTime: 5 * 60_000,
      },
      // 写操作失败要么用户改参数重试，要么状态本来就不允许；静默重放会产生第二次状态变更。
      mutations: { retry: 0 },
    },
  });
}

export const queryClient = createQueryClient();
