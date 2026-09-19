import { useState } from 'react';
import { Cloud, CloudOff } from 'lucide-react';
import { Button, Input } from '@/components/ui';
import { useCloudConnect, useCloudDisconnect, useCloudStatus } from '@/features/market/hooks';
import { FormError, SettingRow, SettingSection, TabHeader } from '../components/settings-ui';

/**
 * 服务端市场 Tab（0919 对接层）：连接表单（url/账号/密码）+ 连接状态 + 断开。
 *
 * 密码不落库：服务端向服务端 `POST /cloud/v1/accounts/login` 校验，换取 JWT token
 * 存进 settings kv（本地单机 SQLite，与其它设置同机同权），前端只发一次明文密码。
 * 服务端登录失败（502 CLOUD_ERROR）时错误原文经 toast 透出（useApiMutation 默认行为），
 * 表单下方同时内联展示，方便复制排查。
 */
export function CloudMarketTab() {
  const status = useCloudStatus();
  const connected = status.data?.connected ?? false;

  const [url, setUrl] = useState('');
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [inlineError, setInlineError] = useState<string | null>(null);

  const connect = useCloudConnect(() => {
    setInlineError(null);
    setPassword('');
  });
  const disconnect = useCloudDisconnect();

  const submit = (event: React.FormEvent) => {
    event.preventDefault();
    setInlineError(null);
    if (!url.trim() || !username.trim() || !password) {
      setInlineError('请填写服务地址、账号与密码');
      return;
    }
    connect.mutate({ url: url.trim(), username: username.trim(), password });
    setInlineError(connect.error ? String(connect.error) : null);
  };

  const displayError = inlineError ?? (connect.error ? errorMessageOf(connect.error) : null);

  return (
    <div className="flex flex-col gap-4">
      <TabHeader
        title="服务端市场"
        description="连接服务端市场服务后，市场页聚合服务端技能，可发布同步到服务端、订阅服务端技能并代理评分/评论/反馈。"
      />

      <SettingSection>
        <SettingRow label="连接状态" hint={connected ? `已连接 ${status.data?.url ?? ''}` : '未连接。服务端不可达时市场自动回落本地。'}>
          <div className="flex items-center gap-2">
            {connected ? (
              <>
                <span className="inline-flex items-center gap-1 text-aux text-text-primary">
                  <Cloud className="size-4 text-primary" aria-hidden />
                  ☁ {status.data?.username}
                </span>
                <Button
                  size="sm"
                  variant="ghost"
                  loading={disconnect.isPending}
                  onClick={() => disconnect.mutate(undefined)}
                >
                  <CloudOff className="size-4" aria-hidden />
                  断开
                </Button>
              </>
            ) : (
              <span className="text-aux text-text-tertiary">未连接</span>
            )}
          </div>
        </SettingRow>
      </SettingSection>

      {!connected ? (
        <SettingSection>
          <form className="flex flex-col gap-1" onSubmit={submit}>
            <SettingRow label="服务地址" width="fluid" required>
              <Input
                value={url}
                onChange={(event) => setUrl(event.target.value)}
                placeholder="如 http://127.0.0.1:7789"
                maxLength={500}
              />
            </SettingRow>
            <SettingRow label="账号" width="fluid" required>
              <Input
                value={username}
                onChange={(event) => setUsername(event.target.value)}
                placeholder="服务端市场账号"
                maxLength={100}
              />
            </SettingRow>
            <SettingRow
              label="密码"
              width="fluid"
              required
              hint="仅用于本次登录校验换取 token；本地只保存 token，不保存密码。"
            >
              <Input
                type="password"
                value={password}
                onChange={(event) => setPassword(event.target.value)}
                placeholder="服务端市场密码"
                maxLength={200}
              />
            </SettingRow>
            <div className="flex items-center justify-end gap-2 px-4 pb-3">
              {displayError ? <FormError>{displayError}</FormError> : null}
              <Button type="submit" variant="primary" loading={connect.isPending}>
                连接
              </Button>
            </div>
          </form>
        </SettingSection>
      ) : null}
    </div>
  );
}

function errorMessageOf(error: unknown): string | null {
  if (!error) return null;
  const message = (error as { message?: unknown }).message;
  return typeof message === 'string' && message ? message : String(error);
}
