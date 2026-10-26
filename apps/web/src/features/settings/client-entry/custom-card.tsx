import { useState } from 'react';
import { FolderOpen } from 'lucide-react';
import { Badge, Button, Card, Checkbox, Input, useToast } from '@/components/ui';
import type { ClientDetectResult, ClientEntry, ClientEntryAsset } from '@/api/types';
import { desktop } from '@/app/desktop';
import { ASSET_LABEL, EntryMeta, stabilityClass, stabilityLabel } from './labels';

/**
 * custom 伪客户端（兜底卡）：为不在内置清单里的客户端准备的「手动指定目录」安装卡。
 *
 * 与六端卡（client-card.tsx）的三个刻意差异：
 * - 没有 workspace 依赖：没选项目目录时照常可用（与六端卡的 blockedNoWorkspace 相反），
 *   可见性完全由用户选的目录决定，目录选择是卡片本地状态；
 * - 没有作用域切换：服务端恒按 project 记台账，UI 不提供档位；
 * - targets 恒空：没有固定落点可展示，只说「写入所选目录」「由该客户端自行加载」，
 *   不推断所选客户端的加载机制，也不写死任何客户端名（notes 由 API 下发）。
 *
 * 文案纪律同六端卡：安装动作叫「预览安装」，不承诺安装即生效。
 */

export interface CustomCardProps {
  client: ClientDetectResult;
  onPreview: (assets: ClientEntryAsset[], targetDir: string) => void;
  onVerify: () => void;
  onUninstall: (entry: ClientEntry) => void;
  /** 仅 SSR 测试注入初始目录；设置页渲染时不传（同 ClientEntryTab.initialWorkspace 的口径）。 */
  initialTargetDir?: string;
  busy?: boolean;
}

export function CustomCard({
  client,
  onPreview,
  onVerify,
  onUninstall,
  initialTargetDir = '',
  busy = false,
}: CustomCardProps) {
  const toast = useToast();
  const [targetDir, setTargetDir] = useState(initialTargetDir);
  const [selected, setSelected] = useState<Record<ClientEntryAsset, boolean>>(() => ({
    rule: client.assets.includes('rule'),
    skill: client.assets.includes('skill'),
  }));

  const selectedAssets = client.assets.filter((asset) => selected[asset]);
  const hasTargetDir = targetDir.trim() !== '';
  const previewDisabled = busy || !hasTargetDir || selectedAssets.length === 0;

  const handlePickFolder = () => {
    // 三种结局与 tabs/client-entry.tsx 的 handlePickFolder 同口径：
    // 取消（空串）静默、无桌面壳提示手输、命令报错带上原因。
    // 不走 desktop.pickFolder()——那条路径把 error 与 absent 都吞成 null，界面只能猜。
    void desktop.tryInvoke<string>('pick_folder').then((outcome) => {
      if (outcome.kind === 'ok') {
        const picked = typeof outcome.value === 'string' ? outcome.value : '';
        // 空串 = 用户取消，保持现值、不打扰。
        if (picked) setTargetDir(picked);
        return;
      }
      if (outcome.kind === 'absent') {
        toast.info('浏览器开发态无法打开目录选择器，请手动输入绝对路径');
        return;
      }
      toast.error('目录选择器打开失败，请手动输入绝对路径', outcome.message);
    });
  };

  return (
    <Card className="flex flex-col gap-3 p-4">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <h3 className="text-card-title text-text-primary">{client.label}</h3>
          {client.notes.map((note) => (
            <p key={note} className="mt-0.5 text-aux text-text-secondary">
              {note}
            </p>
          ))}
        </div>
        <div className="flex shrink-0 flex-wrap justify-end gap-1">
          {client.assets.map((asset) => (
            <Badge key={asset} className={stabilityClass(client.stability[asset])}>
              {stabilityLabel(client.stability[asset])}
            </Badge>
          ))}
        </div>
      </div>

      <div className="flex flex-wrap items-end gap-2">
        <div className="min-w-[240px] flex-1">
          <label htmlFor="custom-client-target-dir" className="mb-1 block text-aux text-text-secondary">
            安装目录
          </label>
          <Input
            id="custom-client-target-dir"
            value={targetDir}
            placeholder="/path/to/client/rules"
            className="font-mono text-code"
            disabled={busy}
            onChange={(event) => setTargetDir(event.target.value)}
          />
        </div>
        <Button icon={<FolderOpen className="size-4" />} disabled={busy} onClick={handlePickFolder}>
          选择文件夹
        </Button>
      </div>

      <div className="flex flex-col gap-2">
        {client.assets.map((asset) => {
          const entry = client.entries.find((item) => item.assetType === asset);
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
                <p className="mt-1 text-aux text-text-tertiary">
                  写入所选目录，由该客户端自行加载
                </p>
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
          onClick={() => onPreview(selectedAssets, targetDir.trim())}
        >
          {hasTargetDir ? '预览安装' : '先选择目录'}
        </Button>
        <Button disabled={busy} onClick={onVerify}>
          校验
        </Button>
      </div>
    </Card>
  );
}
