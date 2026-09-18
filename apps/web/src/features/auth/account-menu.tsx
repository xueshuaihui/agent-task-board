import { useState } from 'react';
import { KeyRound, LogOut, ShieldCheck, UserRound, UsersRound } from 'lucide-react';
import { Menu, MenuCaret } from '@/components/ui';
import { accountLabel, roleLabel } from './api';
import { ChangePasswordDialog } from './change-password-dialog';
import { SwitchAccountDialog } from './switch-account-dialog';
import { UserManageDialog } from './user-manage-dialog';
import { useAuthStore } from './store';

/**
 * 2.3 顶栏账号下拉（2.2 顶栏右侧「头像 + 用户名 + ▾」）：
 * 账号信息 / 切换账号（16.1）/ 修改密码 / ADMIN 的「用户管理」 / 退出登录。
 * 三个动作都是弹窗，菜单只做入口；退出登录直接清会话回登录页（16.3 的
 * 「本地数据处理」三选一属于后续工作区功能，本地库本就保留，这里不做分支）。
 */
export function AccountMenu() {
  const account = useAuthStore((state) => state.account);
  const logout = useAuthStore((state) => state.logout);
  const [switchOpen, setSwitchOpen] = useState(false);
  const [passwordOpen, setPasswordOpen] = useState(false);
  const [usersOpen, setUsersOpen] = useState(false);

  if (!account) return null;

  const isAdmin = account.role === 'ADMIN';

  return (
    <>
      <Menu
        align="end"
        width={220}
        trigger={({ open, toggle }) => (
          <button
            type="button"
            onClick={toggle}
            aria-label="账号菜单"
            aria-expanded={open}
            className="flex h-8 items-center gap-2 rounded-control px-2 transition-colors duration-120 hover:bg-bg-muted"
          >
            <span className="flex size-6 shrink-0 items-center justify-center rounded-full bg-primary-light text-aux font-medium text-primary">
              {accountLabel(account).slice(0, 1).toUpperCase()}
            </span>
            <span className="max-w-24 truncate text-body text-text-primary">
              {accountLabel(account)}
            </span>
            <MenuCaret open={open} />
          </button>
        )}
        groups={[
          {
            label: '当前账号',
            items: [
              {
                id: 'profile',
                icon: <UserRound className="size-4" />,
                label: accountLabel(account),
                hint: roleLabel(account.role),
                onSelect: () => undefined,
              },
            ],
          },
          {
            items: [
              { id: 'switch', icon: <UsersRound className="size-4" />, label: '切换账号', onSelect: () => setSwitchOpen(true) },
              { id: 'password', icon: <KeyRound className="size-4" />, label: '修改密码', onSelect: () => setPasswordOpen(true) },
              ...(isAdmin
                ? [
                    {
                      id: 'users',
                      icon: <ShieldCheck className="size-4" />,
                      label: '用户管理',
                      onSelect: () => setUsersOpen(true),
                    },
                  ]
                : []),
            ],
          },
          {
            items: [
              {
                id: 'logout',
                icon: <LogOut className="size-4" />,
                label: '退出登录',
                danger: true,
                onSelect: () => void logout().then(() => {
                  window.location.hash = '#/login';
                }),
              },
            ],
          },
        ]}
      />

      <SwitchAccountDialog open={switchOpen} onClose={() => setSwitchOpen(false)} />
      <ChangePasswordDialog open={passwordOpen} onClose={() => setPasswordOpen(false)} />
      <UserManageDialog open={usersOpen} onClose={() => setUsersOpen(false)} />
    </>
  );
}
