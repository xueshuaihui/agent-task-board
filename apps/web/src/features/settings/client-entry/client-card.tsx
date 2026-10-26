import { useState } from 'react';
import { Badge, Button, Card, Checkbox } from '@/components/ui';
import type {
  ClientDetectResult,
  ClientEntry,
  ClientEntryAsset,
  ClientEntryScope,
} from '@/api/types';
import {
  ASSET_LABEL,
  EntryMeta,
  stabilityClass,
  stabilityLabel,
} from './labels';

/**
 * 六端检测结果里的一张卡。
 *
 * 文案纪律（本片硬约束）：
 * - 只说明「检测到/未检测到配置目录」，不推断客户端本身是否装好；
 * - 安装动作叫「预览安装 / 已安装 N 项」，不承诺超越文件写入的效果。
 *
 * 作用域与资产选择都是卡片本地状态：作用域只展示 `client.scopes` 里有的档位，
 * 未选目录时只允许用户级（客户端没有用户级时整卡提示先选目录并禁用安装）。
 * 状态/资产徽章等共用映射在 `./labels`，custom 兜底卡同源。
 */

const SCOPE_LABEL: Record<ClientEntryScope, string> = {
  project: '项目级',
  user: '用户级',
};

export interface ClientCardProps {
  client: ClientDetectResult;
  workspace: string;
  onPreview: (scope: ClientEntryScope, assets: ClientEntryAsset[]) => void;
  onVerify: () => void;
  onUninstall: (entry: ClientEntry) => void;
  onSelfTest: () => void;
  onCopyRule: (scope: ClientEntryScope) => void;
  busy?: boolean;
}

function detectedText(client: ClientDetectResult, scope: ClientEntryScope): string {
  return client.detected[scope]
    ? `检测到${SCOPE_LABEL[scope]}配置目录`
    : `未检测到${SCOPE_LABEL[scope]}配置目录（仍可安装）`;
}

export function ClientCard({
  client,
  workspace,
  onPreview,
  onVerify,
  onUninstall,
  onSelfTest,
  onCopyRule,
  busy = false,
}: ClientCardProps) {
  const hasWorkspace = workspace.trim() !== '';
  const [scope, setScope] = useState<ClientEntryScope>(() =>
    hasWorkspace && client.scopes.includes('project') ? 'project' : 'user',
  );
  const [selected, setSelected] = useState<Record<ClientEntryAsset, boolean>>(() => ({
    rule: client.assets.includes('rule'),
    skill: client.assets.includes('skill'),
  }));

  const activeScope: ClientEntryScope = hasWorkspace
    ? client.scopes.includes(scope)
      ? scope
      : (client.scopes[0] ?? 'user')
    : 'user';
  // 没有项目目录的客户端只提供项目级时，整卡改成「先选目录」提示；展示仍按项目级矩阵。
  const blockedNoWorkspace = !hasWorkspace && !client.scopes.includes('user');
  const displayScope: ClientEntryScope = blockedNoWorkspace ? 'project' : activeScope;
  const availableScopes = hasWorkspace
    ? client.scopes
    : client.scopes.filter((item) => item === 'user');
  const selectedAssets = client.assets.filter((asset) => selected[asset]);
  const previewDisabled =
    busy ||
    blockedNoWorkspace ||
    selectedAssets.length === 0 ||
    !client.scopes.includes(activeScope);

  return (
    <Card className="flex flex-col gap-3 p-4">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <h3 className="text-card-title text-text-primary">{client.label}</h3>
          <p className="mt-0.5 text-aux text-text-secondary">
            {detectedText(client, displayScope)}
          </p>
        </div>
        <div className="flex shrink-0 flex-wrap justify-end gap-1">
          {client.assets.map((asset) => (
            <Badge key={asset} className={stabilityClass(client.stability[asset])}>
              {stabilityLabel(client.stability[asset])}
            </Badge>
          ))}
        </div>
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <span className="text-aux text-text-secondary">作用域</span>
        <div className="flex items-center gap-1">
          {availableScopes.map((item) => (
            <Button
              key={item}
              size="sm"
              variant={activeScope === item ? 'subtle' : 'ghost'}
              disabled={busy}
              onClick={() => setScope(item)}
            >
              {SCOPE_LABEL[item]}
            </Button>
          ))}
        </div>
        {blockedNoWorkspace ? (
          <span className="text-aux text-status-running">需要先选择项目目录</span>
        ) : null}
      </div>

      <div className="flex flex-col gap-2">
        {client.assets.map((asset) => {
          const target = client.targets.find(
            (item) => item.scope === displayScope && item.asset === asset,
          );
          const entry = client.entries.find(
            (item) => item.scope === displayScope && item.assetType === asset,
          );
          return (
            <div
              key={asset}
              className="flex items-start gap-2 rounded-control border border-border px-3 py-2"
            >
              <Checkbox
                className="mt-0.5"
                checked={selected[asset]}
                disabled={busy}
                aria-label={`安装${ASSET_LABEL[asset]}`}
                onChange={(event) =>
                  setSelected((prev) => ({ ...prev, [asset]: event.target.checked }))
                }
              />
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="text-body text-text-primary">{ASSET_LABEL[asset]}</span>
                  <Badge className={stabilityClass(client.stability[asset])}>
                    {stabilityLabel(client.stability[asset])}
                  </Badge>
                </div>

                {target ? (
                  <>
                    <p className="mt-1 font-mono text-code break-all text-text-secondary">
                      {target.path}
                    </p>
                    <p className="mt-0.5 flex flex-wrap gap-x-2 text-aux text-text-tertiary">
                      <span>{target.exists ? '已存在' : '将新建'}</span>
                      <span>
                        {target.writeMode === 'managed_block' ? '托管块' : '独立文件'}
                      </span>
                    </p>
                  </>
                ) : (
                  <p className="mt-1 text-aux text-text-tertiary">
                    {displayScope === 'project'
                      ? '选择项目目录后显示落点'
                      : '该客户端不提供此项'}
                  </p>
                )}

                {entry ? <EntryMeta entry={entry} busy={busy} onUninstall={onUninstall} /> : null}
              </div>
            </div>
          );
        })}
      </div>

      <div className="mt-auto flex flex-wrap items-center gap-2 border-t border-border pt-3">
        <Button
          variant="primary"
          disabled={previewDisabled}
          onClick={() => onPreview(activeScope, selectedAssets)}
        >
          预览安装
        </Button>
        <Button disabled={busy} onClick={onVerify}>
          校验
        </Button>
        <Button
          variant="ghost"
          disabled={busy || blockedNoWorkspace}
          onClick={() => onCopyRule(activeScope)}
        >
          复制规则
        </Button>
        <Button variant="ghost" onClick={onSelfTest}>
          自测
        </Button>
      </div>
    </Card>
  );
}
