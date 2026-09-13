import { useCallback } from 'react';
import { desktop } from '@/app/desktop';
import { useToast } from '@/components/ui';

/**
 * 复制：先走 Web Clipboard（浏览器开发态与 WebView 都大概率可用），
 * 失败或被权限挡下再交桌面壳的 `clipboard_write`（`desktop.copyText` 内部也会兜回剪贴板）。
 *
 * 单独一个钩子而不是就地 `navigator.clipboard.writeText`：Token 明文与 MCP 地址这两处
 * 都要给「已复制 / 复制失败」的反馈，而 `desktop.copyText` 是静默的（基座注释就是这句），
 * 用户关掉一次性明文弹窗前必须知道有没有复制成功。
 */
export function useCopy(): (text: string, label: string) => Promise<void> {
  const toast = useToast();
  return useCallback(
    async (text: string, label: string) => {
      if (!text) {
        toast.error('没有可复制的内容');
        return;
      }
      try {
        if (navigator.clipboard?.writeText) {
          await navigator.clipboard.writeText(text);
          toast.success(`${label}已复制`);
          return;
        }
      } catch {
        /* WebView 无剪贴板权限：落到桌面壳 */
      }
      await desktop.copyText(text);
      toast.success(`${label}已复制`, desktop.isDesktop ? undefined : '浏览器开发态若被权限拦截，请手动选中复制');
    },
    [toast],
  );
}
