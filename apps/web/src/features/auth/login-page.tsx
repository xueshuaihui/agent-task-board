import { useState, type FormEvent } from 'react';
import { Diamond } from 'lucide-react';
import { Button, Field, Input } from '@/components/ui';
import { errorMessage, fieldErrorsOf } from '@/api';
import { useRoute } from '@/app/router';
import { cn } from '@/lib/cn';
import { useAuthStore } from './store';

/**
 * 0919 3.1 登录页 + 3.3 首次初始化管理员。
 *
 * 「是否需要初始化」现有接口撑不起自动探测：`/auth/me` 无凭证恒 401、
 * `/auth/users` 需要 ADMIN 会话，后端没有公开的 /auth/status。所以这里用
 * 「登录表单为默认，「首次使用？初始化管理员」切换到初始化表单」的实现——
 * 初始化接口对已存在账号返回 403（「已存在账号，初始化接口已关闭」），
 * 页面捕获后自动切回登录表单并展示原因，不会出现双管理员。
 * 切换账号跳回本页时用 `#/login?username=xxx` 预填用户名（16.1）。
 */
export function LoginPage() {
  const route = useRoute();
  const login = useAuthStore((state) => state.login);
  const initAdmin = useAuthStore((state) => state.initAdmin);

  const [mode, setMode] = useState<'login' | 'init'>('login');
  const [username, setUsername] = useState(route.search.get('username') ?? '');
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const onSubmit = async (event: FormEvent) => {
    event.preventDefault();
    setError(null);
    if (mode === 'init' && password !== confirm) {
      setError('两次输入的密码不一致');
      return;
    }
    setBusy(true);
    try {
      const result =
        mode === 'login'
          ? await login(username.trim(), password)
          : await initAdmin({
              username: username.trim(),
              password,
              display_name: displayName.trim() || undefined,
            });
      // 首登强制改密（3.2）：先去改密页，改完用新 token 进工作区。
      window.location.hash = result.must_change_password ? '#/change-password' : '#/board';
    } catch (cause) {
      const issues = fieldErrorsOf(cause);
      const first = Object.values(issues)[0];
      setError(first ?? errorMessage(cause));
      // 初始化接口对「已有账号」返回 403：自动切回登录，避免用户在死路里打转。
      if (mode === 'init') setMode('login');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex min-h-screen flex-col items-center justify-center bg-bg-app px-4 text-text-primary">
      <div className="mb-8 flex flex-col items-center gap-2">
        <Diamond className="size-10 text-primary" aria-hidden />
        <span className="text-logo">Agent Task Board</span>
      </div>

      <form
        onSubmit={onSubmit}
        className="flex w-full max-w-88 flex-col gap-4 rounded-modal border border-border bg-bg-surface p-6 shadow-modal"
      >
        <h1 className="text-section-title">{mode === 'login' ? '登录' : '初始化管理员账号'}</h1>
        {mode === 'init' ? (
          <p className="text-aux text-text-tertiary">
            首次使用：创建的管理员将拥有「用户管理」权限，初始化接口随后永久关闭。
          </p>
        ) : null}

        <Field label="账号" required htmlFor="auth-username">
          <Input
            id="auth-username"
            value={username}
            onChange={(event) => setUsername(event.target.value)}
            placeholder="3-32 位字母 / 数字 / 下划线 / 连字符"
            autoComplete="username"
            autoFocus
            required
          />
        </Field>

        <Field label="密码" required htmlFor="auth-password" hint={mode === 'init' ? '至少 6 位，最多 64 位' : undefined}>
          <Input
            id="auth-password"
            type="password"
            value={password}
            onChange={(event) => setPassword(event.target.value)}
            autoComplete={mode === 'init' ? 'new-password' : 'current-password'}
            required
          />
        </Field>

        {mode === 'init' ? (
          <>
            <Field label="确认密码" required htmlFor="auth-confirm">
              <Input
                id="auth-confirm"
                type="password"
                value={confirm}
                onChange={(event) => setConfirm(event.target.value)}
                autoComplete="new-password"
                required
              />
            </Field>
            <Field label="显示名" htmlFor="auth-display-name" hint="可选，顶栏与账号菜单优先显示">
              <Input
                id="auth-display-name"
                value={displayName}
                onChange={(event) => setDisplayName(event.target.value)}
                maxLength={32}
              />
            </Field>
          </>
        ) : null}

        {error ? (
          <p role="alert" className="text-aux text-status-failed">
            {error}
          </p>
        ) : null}

        <Button type="submit" variant="primary" loading={busy} disabled={!username.trim() || !password}>
          {mode === 'login' ? '登 录' : '创建并登录'}
        </Button>

        <button
          type="button"
          onClick={() => {
            setMode(mode === 'login' ? 'init' : 'login');
            setError(null);
          }}
          className={cn(
            'text-aux text-text-tertiary transition-colors duration-120 hover:text-primary',
            'self-center',
          )}
        >
          {mode === 'login' ? '首次使用？初始化管理员账号' : '已有账号？返回登录'}
        </button>
        {mode === 'login' ? (
          <p className="self-center text-aux text-text-tertiary">忘记密码？请联系管理员重置</p>
        ) : null}
      </form>
    </div>
  );
}
