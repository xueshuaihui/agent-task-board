import { useEffect, type ReactNode } from 'react';
import { ensureBootstrap, useAuthStore } from './store';

/**
 * 认证守卫：包住工作区壳（app.tsx）。boot 期间渲染骨架占位，避免未登录时闪业务页。
 *
 * - 无 token（本地登录态与注入的 ATB_UI_TOKEN 都没有）→ /login；
 * - 有 token：bootstrap 用它换一次 /auth/me；me 失败 → /login（onUnauthorized 已清会话）；
 * - `must_change_password` → /change-password（0919 3.2，后端对业务接口同样放
 *   403 MUST_CHANGE_PASSWORD 双保险）。
 */
export function RequireAuth({ children }: { children: ReactNode }) {
  const ready = useAuthStore((state) => state.ready);
  const token = useAuthStore((state) => state.token);
  const account = useAuthStore((state) => state.account);

  useEffect(() => {
    void ensureBootstrap();
  }, []);

  useEffect(() => {
    if (!ready) return;
    if (!token) {
      window.location.hash = '#/login';
      return;
    }
    if (account?.must_change_password && !window.location.hash.startsWith('#/change-password')) {
      window.location.hash = '#/change-password';
    }
  }, [ready, token, account]);

  if (!ready) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-bg-app">
        <span className="text-aux text-text-tertiary">正在恢复会话…</span>
      </div>
    );
  }
  if (!token || account?.must_change_password) return null;
  return <>{children}</>;
}
