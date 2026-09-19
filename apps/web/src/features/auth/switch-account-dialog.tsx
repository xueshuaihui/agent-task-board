import { useState } from 'react';
import { Check, CircleUser, Plus } from 'lucide-react';
import { Button, Dialog } from '@/components/ui';
import { accountLabel } from './api';
import { useAuthStore } from './store';

/**
 * 16.1 切换账号对话框。
 *
 * 拍板决策：为避免本机存明文密码，「切换」＝登出当前会话并回到登录页、
 * 预填目标用户名，密码由用户输入。列表来自 localStorage 里记住的用户名
 * （`atb.auth.accounts`，见 store.ts），不含任何凭证。
 */
export function SwitchAccountDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const account = useAuthStore((state) => state.account);
  const remembered = useAuthStore((state) => state.remembered);
  const logout = useAuthStore((state) => state.logout);
  const [busy, setBusy] = useState(false);

  const names = remembered();
  const currentUsername = account?.username ?? '';

  const switchTo = async (username: string) => {
    setBusy(true);
    try {
      await logout();
    } finally {
      window.location.hash = `#/login?username=${encodeURIComponent(username)}`;
    }
  };

  const rows = names.filter((name) => name !== currentUsername);

  return (
    <Dialog
      open={open}
      onClose={onClose}
      title="切换账号"
      footer={
        <>
          <Button onClick={onClose}>取消</Button>
          <Button
            icon={<Plus className="size-4" />}
            loading={busy}
            onClick={() => void switchTo('')}
          >
            添加账号
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-2">
        <p className="text-aux text-text-tertiary">选择本机登录过的账号</p>

        {account ? (
          <AccountRow
            name={account.username}
            label={accountLabel(account)}
            sub="当前账号"
            current
            busy={busy}
            onSelect={() => void switchTo(account.username)}
          />
        ) : null}

        {rows.map((name) => (
          <AccountRow
            key={name}
            name={name}
            label={name}
            sub="切换后需重新输入密码"
            busy={busy}
            onSelect={() => void switchTo(name)}
          />
        ))}

        {names.length === 0 && !account ? (
          <p className="text-aux text-text-tertiary">本机还没有登录过任何账号</p>
        ) : null}

        <p className="mt-1 text-aux text-text-tertiary">
          ⓘ 切换后，分组、任务和技能将显示为目标账号的数据。
        </p>
      </div>
    </Dialog>
  );
}

function AccountRow({
  name,
  label,
  sub,
  current,
  busy,
  onSelect,
}: {
  name: string;
  label: string;
  sub: string;
  current?: boolean;
  busy: boolean;
  onSelect: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onSelect}
      disabled={busy}
      className="flex items-center gap-3 rounded-control border border-border bg-bg-raised px-3 py-2.5 text-left transition-colors duration-120 hover:bg-bg-muted disabled:opacity-60"
    >
      <span className="flex size-4 shrink-0 items-center justify-center">
        {current ? <Check className="size-3.5 text-primary" /> : <CircleUser className="size-4 text-text-secondary" />}
      </span>
      <span className="min-w-0 flex-1">
        <span className="block truncate text-body text-text-primary">{label}</span>
        <span className="block truncate text-aux text-text-tertiary">
          {current ? sub : `${sub}（${name}）`}
        </span>
      </span>
    </button>
  );
}
