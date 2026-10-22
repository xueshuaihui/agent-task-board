import { useQuery } from '@tanstack/react-query';
import { api, qk } from '@/api';

/**
 * 设置 → 客户端入口的读查询。
 *
 * 概览按 workspace 分键：空串与服务端「未选择工作区」是同一语义（只返回用户级目标），
 * 所以 trim 后为空就不把参数带进 key，切换目录时才是一份新缓存。
 * 自测记录是独立的轮询查询，弹窗打开期间每 3 秒刷新一次，关闭即停。
 */

export function useClientEntryOverview(workspace: string) {
  const target = workspace.trim() || undefined;
  return useQuery({
    queryKey: qk.clientEntries(target),
    queryFn: () => api.clientEntries.detect(target),
  });
}

export function useClientEntrySelfTest(open: boolean) {
  return useQuery({
    queryKey: qk.clientEntrySelfTest(),
    queryFn: () => api.clientEntries.selfTest(),
    enabled: open,
    refetchInterval: open ? 3000 : false,
  });
}
