import { useState, type FormEvent } from 'react';
import { Button, Dialog, Field, Input } from '@/components/ui';
import { useToast } from '@/components/ui';
import { errorMessage, fieldErrorsOf } from '@/api';
import { useAuthStore } from './store';

/** 修改密码弹窗（顶栏账号菜单入口；服务端成功后返回并整体替换新 token）。 */
export function ChangePasswordDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const changePassword = useAuthStore((state) => state.changePassword);
  const toast = useToast();

  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [confirm, setConfirm] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const reset = () => {
    setCurrent('');
    setNext('');
    setConfirm('');
    setError(null);
  };

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
      reset();
      onClose();
      toast.success('密码已修改，会话已刷新');
    } catch (cause) {
      const issues = fieldErrorsOf(cause);
      setError(Object.values(issues)[0] ?? errorMessage(cause));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open={open} onClose={onClose} title="修改密码">
      <form onSubmit={onSubmit} className="flex flex-col gap-4">
        <Field label="当前密码" required htmlFor="dialog-current-password">
          <Input
            id="dialog-current-password"
            type="password"
            value={current}
            onChange={(event) => setCurrent(event.target.value)}
            autoComplete="current-password"
            required
          />
        </Field>
        <Field label="新密码" required htmlFor="dialog-new-password" hint="至少 6 位，最多 64 位">
          <Input
            id="dialog-new-password"
            type="password"
            value={next}
            onChange={(event) => setNext(event.target.value)}
            autoComplete="new-password"
            required
          />
        </Field>
        <Field label="确认新密码" required htmlFor="dialog-confirm-password">
          <Input
            id="dialog-confirm-password"
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
      </form>
      <footer className="mt-2 flex items-center justify-end gap-2">
        <Button onClick={onClose}>取消</Button>
        <Button type="submit" variant="primary" loading={busy} onClick={onSubmit}>
          确认修改
        </Button>
      </footer>
    </Dialog>
  );
}
