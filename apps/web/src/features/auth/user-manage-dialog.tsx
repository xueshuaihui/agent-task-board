import { useState, type FormEvent } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Button, Dialog, Field, Input, Select, Skeleton, useToast } from '@/components/ui';
import { ApiError, errorMessage } from '@/api';
import { accountLabel, authApi, roleLabel, type AccountInfo } from './api';
import { cn } from '@/lib/cn';

/**
 * 用户管理弹窗（仅 ADMIN 入口可见；后端 `/auth/users` 三件套同样校验 ADMIN 角色）。
 * 覆盖 0919 十四章的管理动作：创建用户、重置密码、禁用 / 启用（改角色暂用
 * `role` 下拉就地切换，`PATCH /auth/users/:id` 一个端点全包）。
 */
export function UserManageDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const toast = useToast();
  const [createOpen, setCreateOpen] = useState(false);
  const [resetting, setResetting] = useState<AccountInfo | null>(null);

  const users = useQuery({
    queryKey: ['auth-users'],
    queryFn: () => authApi.listUsers(),
    enabled: open,
  });

  const run = async (action: () => Promise<unknown>, success: string) => {
    try {
      await action();
      await users.refetch();
      toast.success(success);
    } catch (cause) {
      toast.error(errorMessage(cause));
    }
  };

  return (
    <>
      <Dialog
        open={open}
        onClose={onClose}
        title="用户管理"
        footer={
          <>
            <Button onClick={onClose}>关闭</Button>
            <Button variant="primary" onClick={() => setCreateOpen(true)}>
              创建用户
            </Button>
          </>
        }
      >
        <div className="flex flex-col gap-2">
          {users.isLoading ? (
            <>
              <Skeleton className="h-10 w-full" />
              <Skeleton className="h-10 w-full" />
            </>
          ) : users.isError ? (
            <p role="alert" className="text-aux text-status-failed">
              {users.error instanceof ApiError ? errorMessage(users.error) : '用户列表加载失败'}
            </p>
          ) : (users.data?.items.length ?? 0) === 0 ? (
            <p className="text-aux text-text-tertiary">还没有其他账号</p>
          ) : (
            users.data?.items.map((user) => (
              <div
                key={user.id}
                className="flex items-center gap-3 rounded-control border border-border bg-bg-raised px-3 py-2"
              >
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-body text-text-primary">
                    {accountLabel(user)}
                    <span className="ml-2 text-aux text-text-tertiary">{user.username}</span>
                  </span>
                  <span className="text-aux text-text-tertiary">
                    {roleLabel(user.role)}
                    {user.must_change_password ? ' · 待改密' : ''}
                  </span>
                </span>
                <span
                  className={cn(
                    'text-aux',
                    user.status === 'ACTIVE' ? 'text-text-secondary' : 'text-status-failed',
                  )}
                >
                  {user.status === 'ACTIVE' ? '启用中' : '已禁用'}
                </span>
                <Button size="sm" onClick={() => setResetting(user)}>
                  重置密码
                </Button>
                {user.status === 'ACTIVE' ? (
                  <Button
                    size="sm"
                    variant="outlineDanger"
                    onClick={() =>
                      void run(
                        () => authApi.patchUser(user.id, { status: 'DISABLED' }),
                        `已禁用 ${user.username}`,
                      )
                    }
                  >
                    禁用
                  </Button>
                ) : (
                  <Button
                    size="sm"
                    onClick={() =>
                      void run(
                        () => authApi.patchUser(user.id, { status: 'ACTIVE' }),
                        `已启用 ${user.username}`,
                      )
                    }
                  >
                    启用
                  </Button>
                )}
              </div>
            ))
          )}
        </div>
      </Dialog>

      <CreateUserDialog
        open={createOpen}
        onClose={() => setCreateOpen(false)}
        onCreated={async (username) => {
          setCreateOpen(false);
          await users.refetch();
          toast.success(`已创建 ${username}`);
        }}
        onError={(message) => toast.error(message)}
      />

      <ResetPasswordDialog
        user={resetting}
        onClose={() => setResetting(null)}
        onDone={async (username) => {
          setResetting(null);
          await users.refetch();
          toast.success(`已重置 ${username} 的密码`);
        }}
        onError={(message) => toast.error(message)}
      />
    </>
  );
}

function CreateUserDialog({
  open,
  onClose,
  onCreated,
  onError,
}: {
  open: boolean;
  onClose: () => void;
  onCreated: (username: string) => void | Promise<void>;
  onError: (message: string) => void;
}) {
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [role, setRole] = useState<'MEMBER' | 'ADMIN'>('MEMBER');
  const [busy, setBusy] = useState(false);

  const onSubmit = async (event: FormEvent) => {
    event.preventDefault();
    setBusy(true);
    try {
      await authApi.createUser({
        username: username.trim(),
        password,
        role,
        display_name: displayName.trim() || undefined,
      });
      setUsername('');
      setPassword('');
      setDisplayName('');
      setRole('MEMBER');
      await onCreated(username.trim());
    } catch (cause) {
      onError(errorMessage(cause));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open={open} onClose={onClose} title="创建用户">
      <form id="create-user-form" onSubmit={onSubmit} className="flex flex-col gap-4">
        <Field label="用户名" required htmlFor="new-user-username" hint="3-32 位字母 / 数字 / 下划线 / 连字符">
          <Input
            id="new-user-username"
            value={username}
            onChange={(event) => setUsername(event.target.value)}
            required
          />
        </Field>
        <Field label="初始密码" required htmlFor="new-user-password" hint="至少 6 位；用户首登会被要求改密">
          <Input
            id="new-user-password"
            type="password"
            value={password}
            onChange={(event) => setPassword(event.target.value)}
            required
          />
        </Field>
        <Field label="显示名" htmlFor="new-user-display-name">
          <Input
            id="new-user-display-name"
            value={displayName}
            onChange={(event) => setDisplayName(event.target.value)}
            maxLength={32}
          />
        </Field>
        <Field label="角色" htmlFor="new-user-role">
          <Select
            id="new-user-role"
            value={role}
            onChange={(event) => setRole(event.target.value as 'MEMBER' | 'ADMIN')}
            options={[
              { value: 'MEMBER', label: '成员' },
              { value: 'ADMIN', label: '管理员' },
            ]}
          />
        </Field>
      </form>
      <footer className="mt-2 flex items-center justify-end gap-2">
        <Button onClick={onClose}>取消</Button>
        <Button type="submit" variant="primary" loading={busy} onClick={onSubmit} disabled={!username.trim() || !password}>
          创建
        </Button>
      </footer>
    </Dialog>
  );
}

function ResetPasswordDialog({
  user,
  onClose,
  onDone,
  onError,
}: {
  user: AccountInfo | null;
  onClose: () => void;
  onDone: (username: string) => void | Promise<void>;
  onError: (message: string) => void;
}) {
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);

  const submit = async () => {
    if (!user || !password) return;
    setBusy(true);
    try {
      await authApi.patchUser(user.id, { password });
      setPassword('');
      await onDone(user.username);
    } catch (cause) {
      onError(errorMessage(cause));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog
      open={user !== null}
      onClose={onClose}
      title={`重置密码 · ${user ? user.username : ''}`}
      footer={
        <>
          <Button onClick={onClose}>取消</Button>
          <Button variant="primary" loading={busy} disabled={!password} onClick={() => void submit()}>
            重置
          </Button>
        </>
      }
    >
      <Field label="新密码" required htmlFor="reset-password" hint="重置后请通知该用户用新密码登录">
        <Input
          id="reset-password"
          type="password"
          value={password}
          onChange={(event) => setPassword(event.target.value)}
          autoComplete="new-password"
        />
      </Field>
    </Dialog>
  );
}
