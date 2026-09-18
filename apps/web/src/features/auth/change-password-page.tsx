import { useEffect, useState, type FormEvent } from 'react';
import { Button, Field, Input } from '@/components/ui';
import { errorMessage, fieldErrorsOf } from '@/api';
import { useAuthStore } from './store';

/**
 * 0919 3.2 首登强制改密。路由守卫（app.tsx）在会话 `must_change_password=true` 时把
 * 其他页面都挡在这里；后端同时把业务接口全部放 403 MUST_CHANGE_PASSWORD（双保险，
 * 请求层 onMustChangePassword 也会把用户拉回本页）。
 *
 * 成功后后端签发新 token，store 整体替换（旧 token 的强制改密语义已过期），
 * 随后正常进工作区。
 */
export function ChangePasswordPage() {
  const token = useAuthStore((state) => state.token);
  const account = useAuthStore((state) => state.account);
  const changePassword = useAuthStore((state) => state.changePassword);

  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [confirm, setConfirm] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  // 未登录 / 已过改密关：各回各家（守卫语义的兜底，正常路径不会走到）。
  useEffect(() => {
    if (!token) window.location.hash = '#/login';
    else if (account && !account.must_change_password) window.location.hash = '#/board';
  }, [token, account]);

  const onSubmit = async (event: FormEvent) => {
    event.preventDefault();
    setError(null);
    if (next !== confirm) {
      setError('两次输入的新密码不一致');
      return;
    }
    setBusy(true);
    try {
      await changePassword(current, next);
      window.location.hash = '#/board';
    } catch (cause) {
      const issues = fieldErrorsOf(cause);
      setError(Object.values(issues)[0] ?? errorMessage(cause));
    } finally {
      setBusy(false);
    }
  };

  if (!token || (account && !account.must_change_password)) return null;

  return (
    <div className="flex min-h-screen flex-col items-center justify-center bg-bg-app px-4 text-text-primary">
      <form
        onSubmit={onSubmit}
        className="flex w-full max-w-88 flex-col gap-4 rounded-modal border border-border bg-bg-surface p-6 shadow-modal"
      >
        <h1 className="text-section-title">首次登录，请修改密码</h1>
        <p className="text-aux text-text-tertiary">为了账号安全，首次登录需要修改初始密码</p>

        <Field label="当前密码" required htmlFor="auth-current-password">
          <Input
            id="auth-current-password"
            type="password"
            value={current}
            onChange={(event) => setCurrent(event.target.value)}
            autoComplete="current-password"
            required
          />
        </Field>
        <Field
          label="新密码"
          required
          htmlFor="auth-new-password"
          hint="至少 6 位，最多 64 位；需与当前密码不同"
        >
          <Input
            id="auth-new-password"
            type="password"
            value={next}
            onChange={(event) => setNext(event.target.value)}
            autoComplete="new-password"
            required
          />
        </Field>
        <Field label="确认新密码" required htmlFor="auth-confirm-password">
          <Input
            id="auth-confirm-password"
            type="password"
            value={confirm}
            onChange={(event) => setConfirm(event.target.value)}
            autoComplete="new-password"
            required
          />
        </Field>

        {error ? (
          <p role="alert" className="text-aux text-status-failed">
            {error}
          </p>
        ) : null}

        <Button type="submit" variant="primary" loading={busy}>
          确认修改
        </Button>
      </form>
    </div>
  );
}
