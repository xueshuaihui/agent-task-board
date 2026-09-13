import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { QueryClientProvider } from '@tanstack/react-query';
import { ToastProvider } from '@/components/ui';
import { installExternalLinkGuard, installNavigationGuards, installWebViewGuards } from '@/app/desktop';
import { queryClient } from '@/app/query-client';
import { AppShell } from '@/app/app';
import { startRouter } from '@/app/router';
import { WSProvider } from '@/ws';
import './styles/globals.css';

/**
 * 应用入口。三件事的顺序有依赖：
 * 1. `startRouter()` 在挂载前把 `#/<path>` 规范化进 store，首帧就是正确页面，
 *    不会先闪一下看板再跳到 `#/settings?tab=tokens`（2.2 深链、2.3 托盘菜单都靠这个）。
 * 2. 桌面防护（禁右键、禁后退、外链交系统浏览器）必须在首次渲染前装好，否则首帧的右键菜单能漏出去。
 * 3. Provider 层次：Toast 在最外，WS 在内——`useToast()` 的调用方里包含 WS 失效提示组件。
 */
startRouter();
installWebViewGuards();
installNavigationGuards();
installExternalLinkGuard();

const container = document.getElementById('root');
if (!container) throw new Error('index.html 缺少 #root 挂载点');

createRoot(container).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <ToastProvider>
        <WSProvider>
          <AppShell />
        </WSProvider>
      </ToastProvider>
    </QueryClientProvider>
  </StrictMode>,
);
