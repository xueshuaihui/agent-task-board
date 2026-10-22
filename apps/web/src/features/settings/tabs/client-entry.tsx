import { useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { FolderOpen, RefreshCw } from 'lucide-react';
import {
  api,
  errorCodeOf,
  errorDetailOf,
  errorMessage,
  qk,
  useApiMutation,
} from '@/api';
import type {
  ClientDetectResult,
  ClientEntry,
  ClientEntryAsset,
  ClientEntryInstallResult,
  ClientEntryPlan,
  ClientEntryScope,
  ClientEntryUninstallResult,
  ClientEntryVerifyResult,
} from '@/api/types';
import { Button, EmptyState, ErrorCopy, Input, Skeleton, useToast } from '@/components/ui';
import { InlineError } from '@/features/task-detail/ui-bits';
import { desktop } from '@/app/desktop';
import { navigate } from '@/app/router';
import { ConfirmDialog } from '../components/confirm-dialog';
import { SettingSection, TabHeader } from '../components/settings-ui';
import { settingsTabSearch } from '../tabs';
import { useCopy } from '../use-copy';
import { ClientCard } from '../client-entry/client-card';
import { PlanDialog, type PlanConfirmOptions } from '../client-entry/plan-dialog';
import { SelfTestDialog } from '../client-entry/self-test-dialog';
import { useClientEntryOverview } from '../client-entry/client-entry-queries';

/**
 * 设置 → 客户端入口（v0.0.4 W9）。
 *
 * 页面只做编排：检测概览来自 `GET /client-entries`，所有写盘动作都先 `plan` 再 `install`，
 * 冲突与字符上限都由服务端计划决定。文案只承诺「规则/技能文件已安装」「MCP 工具链路已验证」。
 */

export interface ClientEntryTabProps {
  /** 仅 SSR 测试注入初始目录；设置页渲染时不传。 */
  initialWorkspace?: string;
}

interface PreviewState {
  client: ClientDetectResult;
  scope: ClientEntryScope;
  /** 预览时的目录快照：弹窗打开后即使用户改了工具条，也按这份计划安装。 */
  workspace: string;
  assets: ClientEntryAsset[];
  plan: ClientEntryPlan;
}

interface PreviewVars {
  detected: ClientDetectResult;
  scope: ClientEntryScope;
  workspace: string;
  assets: ClientEntryAsset[];
}

interface InstallVars {
  preview: PreviewState;
  allowOverLimit?: boolean;
}

export function ClientEntryTab({ initialWorkspace = '' }: ClientEntryTabProps) {
  // 首帧直接渲染注入值：不放在 effect 里，SSR 断言才能看到项目级目标。
  const [workspace, setWorkspace] = useState(initialWorkspace);
  const query = useClientEntryOverview(workspace);
  const queryClient = useQueryClient();
  const toast = useToast();
  const copy = useCopy();

  const [preview, setPreview] = useState<PreviewState | null>(null);
  const [selfTestFor, setSelfTestFor] = useState<ClientDetectResult | null>(null);
  const [uninstallTarget, setUninstallTarget] = useState<ClientEntry | null>(null);

  const planPreview = useApiMutation<PreviewVars, ClientEntryPlan>(
    (vars) =>
      api.clientEntries.plan({
        client: vars.detected.client,
        scope: vars.scope,
        workspace: vars.scope === 'project' ? vars.workspace || undefined : undefined,
        assets: vars.assets,
      }),
    {
      toastOnError: false,
      onSuccess: (plan, vars) => {
        setPreview({
          client: vars.detected,
          scope: vars.scope,
          workspace: vars.workspace,
          assets: vars.assets,
          plan,
        });
      },
      onSettled: (_data, error) => {
        if (!error) return;
        const code = errorCodeOf(error);
        if (code === 'CLIENT_ENTRY_PLAN_STALE') {
          toast.warning('文件在预览后被修改，已重新读取，请再试一次');
        } else if (code === 'CLIENT_ENTRY_CONFLICT') {
          toast.error(errorMessage(error), errorDetailOf(error));
        } else if (code === 'CLIENT_ENTRY_PATH_UNSAFE') {
          toast.error(errorMessage(error));
        } else {
          toast.error(errorMessage(error), errorDetailOf(error));
        }
      },
    },
  );

  const install = useApiMutation<InstallVars, ClientEntryInstallResult>(
    (vars) =>
      api.clientEntries.install({
        client: vars.preview.client.client,
        scope: vars.preview.scope,
        workspace:
          vars.preview.scope === 'project' ? vars.preview.workspace || undefined : undefined,
        assets: vars.preview.assets,
        planHash: vars.preview.plan.planHash,
        confirm: true,
        ...(vars.allowOverLimit ? { allowOverLimit: true } : {}),
      }),
    {
      toastOnError: false,
      onSuccess: (data) => {
        const covered = data.actions.filter((action) => action.action !== 'conflict').length;
        setPreview(null);
        toast.success(`已安装 ${covered} 项`);
        void queryClient.invalidateQueries({ queryKey: qk.clientEntriesRoot });
      },
      onSettled: (_data, error, vars) => {
        // 文件在预览后被改过：自动重新预览，弹窗里保留错误说明与「重新预览」入口。
        if (errorCodeOf(error) !== 'CLIENT_ENTRY_PLAN_STALE') return;
        toast.warning('文件在预览后被修改，已重新读取，请再试一次');
        planPreview.mutate({
          detected: vars.preview.client,
          scope: vars.preview.scope,
          workspace: vars.preview.workspace,
          assets: vars.preview.assets,
        });
      },
    },
  );

  const verify = useApiMutation<{ ids: string[] }, ClientEntryVerifyResult>(
    ({ ids }) => api.clientEntries.verify({ ids }),
    {
      onSuccess: (data) => {
        toast.info(
          `校验完成：已安装 ${data.summary.installed} / 漂移 ${data.summary.drifted} / 缺失 ${data.summary.missing} / 失败 ${data.summary.error}`,
        );
        void queryClient.invalidateQueries({ queryKey: qk.clientEntriesRoot });
      },
    },
  );

  const uninstall = useApiMutation<string, ClientEntryUninstallResult>(
    (id) => api.clientEntries.uninstall(id),
    {
      onSuccess: (data) => {
        setUninstallTarget(null);
        if (data.removed && data.kept === 'unmanaged') {
          // 安装前已存在、内容相同被接管的文件：本应用从未拥有它，只删台账。
          toast.info('该文件安装前已存在，已保留原文件，仅移除安装记录');
        } else if (data.removed) {
          toast.success('已卸载');
        } else if (data.kept === 'drifted') {
          toast.warning('文件已被修改，未删除；台账已标记为漂移');
        } else {
          toast.info('没有可删除的内容');
        }
        void queryClient.invalidateQueries({ queryKey: qk.clientEntriesRoot });
      },
    },
  );

  const copyRule = useApiMutation<
    { detected: ClientDetectResult; scope: ClientEntryScope; workspace: string },
    ClientEntryPlan
  >(
    (vars) =>
      api.clientEntries.plan({
        client: vars.detected.client,
        scope: vars.scope,
        workspace: vars.scope === 'project' ? vars.workspace || undefined : undefined,
        assets: ['rule'],
      }),
    {
      toastOnError: false,
      onSuccess: (plan, vars) => {
        const rule = plan.actions.find((action) => action.assetType === 'rule');
        if (!rule?.content) {
          toast.info('没有可复制的规则内容');
          return;
        }
        // 冲突时服务端仍返回预览正文：照样允许复制，让用户手动合并。
        void copy(rule.content, `${vars.detected.label} 规则`);
      },
      onSettled: (_data, error) => {
        if (error) toast.error(errorMessage(error), errorDetailOf(error));
      },
    },
  );

  const handlePreview = (
    detected: ClientDetectResult,
    scope: ClientEntryScope,
    assets: ClientEntryAsset[],
  ) => {
    install.reset();
    planPreview.mutate({ detected, scope, workspace: workspace.trim(), assets });
  };

  const handleReplan = () => {
    if (!preview) return;
    install.reset();
    planPreview.mutate({
      detected: preview.client,
      scope: preview.scope,
      workspace: preview.workspace,
      assets: preview.assets,
    });
  };

  const handleConfirm = (options: PlanConfirmOptions) => {
    if (!preview) return;
    install.mutate({ preview, allowOverLimit: options.allowOverLimit });
  };

  const handleVerify = (detected: ClientDetectResult) => {
    const ids = detected.entries.map((entry) => entry.id);
    if (ids.length === 0) {
      toast.info('该客户端还没有安装记录');
      return;
    }
    verify.mutate({ ids });
  };

  const handleCopyRule = (detected: ClientDetectResult, scope: ClientEntryScope) => {
    copyRule.mutate({ detected, scope, workspace: workspace.trim() });
  };

  const handlePickFolder = () => {
    // 用 tryInvoke 拿三种结局：取消（空串）静默、无桌面壳提示手输、命令报错带上原因。
    // 不走 desktop.pickFolder()——那条路径把 error 与 absent 都吞成 null，界面只能猜。
    void desktop.tryInvoke<string>('pick_folder').then((outcome) => {
      if (outcome.kind === 'ok') {
        const picked = typeof outcome.value === 'string' ? outcome.value : '';
        // 空串 = 用户取消，保持现值、不打扰。
        if (picked) setWorkspace(picked);
        return;
      }
      if (outcome.kind === 'absent') {
        toast.info('浏览器开发态无法打开目录选择器，请手动输入绝对路径');
        return;
      }
      toast.error('目录选择器打开失败，请手动输入绝对路径', outcome.message);
    });
  };

  const selfTest = query.data?.selfTest;
  const clients = query.data?.clients ?? [];

  return (
    <div className="flex flex-col gap-4">
      <TabHeader
        title="客户端入口"
        description="在客户端落一份 always-on 规则 + 一份按需技能，让『贾维斯』能触发 MCP 工具；文件写入前先预览。"
      />

      <SettingSection title="检测与安装">
        <div className="flex flex-col gap-3 py-3">
          <div className="flex flex-wrap items-end gap-2">
            <div className="min-w-[240px] flex-1">
              <label
                htmlFor="client-entry-workspace"
                className="mb-1 block text-aux text-text-secondary"
              >
                项目目录
              </label>
              <Input
                id="client-entry-workspace"
                value={workspace}
                placeholder="/path/to/project"
                className="font-mono text-code"
                onChange={(event) => setWorkspace(event.target.value)}
              />
            </div>
            <Button icon={<FolderOpen className="size-4" />} onClick={handlePickFolder}>
              选择文件夹
            </Button>
            <Button
              icon={<RefreshCw className="size-4" />}
              disabled={query.isFetching}
              onClick={() => void query.refetch()}
            >
              刷新检测
            </Button>
            <Button
              variant="ghost"
              onClick={() => navigate('settings', settingsTabSearch('tokens'))}
            >
              连接配置 → 令牌页
            </Button>
          </div>

          <div className="flex flex-wrap gap-x-6 gap-y-1 text-aux text-text-secondary">
            <span>
              MCP 服务：
              <span className="font-mono text-code text-text-primary">
                {selfTest?.serverName ?? '—'}
              </span>
            </span>
            <span>
              端点：
              <span className="font-mono text-code break-all text-text-primary">
                {selfTest?.mcpEndpoint ?? '—'}
              </span>
            </span>
          </div>
        </div>
      </SettingSection>

      {query.isPending ? (
        <Skeleton lines={6} />
      ) : query.isError ? (
        <InlineError text={<ErrorCopy error={query.error} />} />
      ) : clients.length === 0 ? (
        <EmptyState
          title="没有可用的客户端适配器"
          description="本地服务未返回任何客户端定义，请重启应用后重试。"
        />
      ) : (
        <div className="grid gap-4 xl:grid-cols-2">
          {clients.map((detected) => (
            <ClientCard
              key={`${detected.client}:${workspace.trim()}`}
              client={detected}
              workspace={workspace.trim()}
              busy={planPreview.isPending || copyRule.isPending || verify.isPending}
              onPreview={(scope, assets) => handlePreview(detected, scope, assets)}
              onVerify={() => handleVerify(detected)}
              onUninstall={(entry) => setUninstallTarget(entry)}
              onSelfTest={() => setSelfTestFor(detected)}
              onCopyRule={(scope) => handleCopyRule(detected, scope)}
            />
          ))}
        </div>
      )}

      {preview ? (
        <PlanDialog
          open
          clientLabel={preview.client.label}
          plan={preview.plan}
          installing={install.isPending}
          error={install.error}
          onClose={() => {
            if (install.isPending) return;
            setPreview(null);
            install.reset();
          }}
          onConfirm={handleConfirm}
          onReplan={handleReplan}
          onCopy={(action) => {
            void copy(
              action.content,
              `${preview.client.label} ${action.assetType === 'rule' ? '规则' : '操作技能'}`,
            );
          }}
        />
      ) : null}

      <ConfirmDialog
        open={uninstallTarget !== null}
        title="卸载客户端入口"
        description="只删除本应用写入的规则/技能，你自己的内容不会动。"
        detail={
          uninstallTarget
            ? `${uninstallTarget.scope === 'project' ? '项目级' : '用户级'} · ${uninstallTarget.targetPath}`
            : undefined
        }
        confirmText="卸载"
        danger
        loading={uninstall.isPending}
        onConfirm={() => {
          if (uninstallTarget) uninstall.mutate(uninstallTarget.id);
        }}
        onClose={() => {
          if (!uninstall.isPending) setUninstallTarget(null);
        }}
      />

      <SelfTestDialog
        open={selfTestFor !== null}
        client={selfTestFor}
        onClose={() => setSelfTestFor(null)}
      />
    </div>
  );
}
