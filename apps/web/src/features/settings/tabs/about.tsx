import { FolderOpen } from 'lucide-react';
import { Button, ErrorCopy } from '@/components/ui';
import { errorCodeOf, useSettings } from '@/api';
import {
  ReadOnlyTag,
  SettingRow,
  SettingSection,
  StaticValue,
  TabHeader,
} from '../components/settings-ui';
import { useOpenDir, useSystemInfo, listenAddress } from '../system-info';
import type { DirTarget } from '../system-info';

/**
 * 关于 Tab（8.5 / 原型 7.9）：只读，无写操作。
 *
 * 「主程序」与「sidecar」两行**必须分开显示**：两者同版本号是巧合，
 * 打包漏带 sidecar 更新是这类双进程应用最常见的分发问题（原型 7.9 原话）。
 *
 * 版本、目录与端口都不在 REST 契约里（13 章无此端点，端口按 10.3 明确不进 settings），
 * 所以数据来自桌面壳的 `system_info` 命令；浏览器开发态拿不到时，
 * 端口从实际请求基址反推、三个目录退回 9.3 / 20.6 的平台约定值并标注，版本号显示 `—`。
 */

export function AboutTab() {
  const { info, fromShell, reason } = useSystemInfo();
  const openDir = useOpenDir();
  const settings = useSettings();

  const versionMismatch =
    info.app_version !== null &&
    info.sidecar_version !== null &&
    info.app_version !== info.sidecar_version;

  return (
    <div className="flex flex-col gap-4">
      {/* 版本号为什么是 `—`：`reason` 只在没拿到主进程应答时非空（8.5 的降级说明）。 */}
      <TabHeader title="关于" description={reason ?? undefined} />

      <SettingSection title="Jarvis Workbench">
        <SettingRow label="主程序版本">
          <div className="flex h-8 items-center">
            <StaticValue mono muted={info.app_version === null}>
              {info.app_version ? `v${info.app_version}` : '—'}
            </StaticValue>
          </div>
        </SettingRow>

        <SettingRow
          label="sidecar 版本"
          hint={
            versionMismatch
              ? '两个版本号不一致：多半是打包时漏带 sidecar 更新。'
              : '与主程序同版本号是巧合，分开看才有意义。'
          }
        >
          <div className="flex h-8 items-center">
            <StaticValue mono muted={info.sidecar_version === null}>
              {info.sidecar_version ? `v${info.sidecar_version}` : '—'}
            </StaticValue>
          </div>
        </SettingRow>

        <SettingRow
          label="服务状态"
          // 具体那一句走码表 +「详情」折叠（2026-09-29「列表三态必须可辨」）：
          // 以前不管 `GET /settings` 是连不上还是 500 `SCHEMA_MISMATCH`，都只印
          // `COPY.sidecarDown`——本地服务明明答了话、答的是「数据库缺少表」，界面却说它没响应。
          error={settings.isError ? <ErrorCopy error={settings.error} /> : undefined}
        >
          <div className="flex h-8 items-center gap-2">
            <ServiceState error={settings.error} pending={settings.isLoading} />
            <StaticValue mono>{listenAddress()}</StaticValue>
            <ReadOnlyTag>10.1 只绑 127.0.0.1</ReadOnlyTag>
          </div>
        </SettingRow>
      </SettingSection>

      <SettingSection
        title="目录"
        description={
          fromShell
            ? '路径来自主进程实测。'
            : '当前不是桌面壳报的路径，而是 9.3 / 20.6 的平台约定值；Windows 路径见 9.3。'
        }
      >
        <DirRow label="数据目录" value={info.data_dir} target="data" onOpen={openDir} />
        <DirRow label="产物目录" value={info.artifacts_dir} target="artifacts" onOpen={openDir} />
        <DirRow label="日志目录" value={info.logs_dir} target="logs" onOpen={openDir} />
        <DirRow label="备份目录" value={info.backup_dir} target="backups" onOpen={openDir} />
      </SettingSection>

      <p className="px-1 text-aux text-text-tertiary">
        本地存储 · 无遥测 · 单机单用户（15 章：不监听 0.0.0.0、不做公网暴露）。
      </p>
    </div>
  );
}

/**
 * 服务状态那一行的灯（原型 7.9）。只给「灯 + 一个短词」，具体那句由 `SettingRow` 的错误位
 * 走 `<ErrorCopy>`。两个短词按错误码分支：`NETWORK_ERROR` 才是真的没响应（连不上、正在重启），
 * 其余（500/503 那一类）服务答了话、只是答不了，写成「无响应」是误导（2026-09-29「列表三态必须可辨」）。
 */
function ServiceState({ error, pending }: { error: unknown; pending: boolean }) {
  if (error) {
    return (
      <span className="inline-flex shrink-0 items-center gap-1.5 text-body text-status-failed">
        <span className="size-2 rounded-full bg-status-failed" aria-hidden />
        {errorCodeOf(error) === 'NETWORK_ERROR' ? '无响应' : '异常'}
      </span>
    );
  }
  if (pending) {
    return (
      <span className="inline-flex items-center gap-1.5 text-body text-text-tertiary">
        <span className="size-2 rounded-full bg-border-strong" aria-hidden />
        连接中…
      </span>
    );
  }
  return (
    <span className="inline-flex items-center gap-1.5 text-body text-text-primary">
      <span className="size-2 rounded-full bg-status-done" aria-hidden />
      运行中
    </span>
  );
}

interface DirRowProps {
  label: string;
  value: string | null;
  target: DirTarget;
  onOpen: (target: DirTarget) => Promise<void>;
}

function DirRow({ label, value, target, onOpen }: DirRowProps) {
  return (
    <SettingRow label={label} width="fluid">
      <div className="flex flex-wrap items-center gap-2 py-1">
        <StaticValue mono muted={value === null} className="min-w-[240px] flex-1">
          {value ?? '—'}
        </StaticValue>
        {/* 浏览器开发态 `open_dir` 是 no-op：按钮照常可点，点了给一句解释，而不是禁用。 */}
        <Button
          size="sm"
          icon={<FolderOpen className="size-3.5" />}
          onClick={() => void onOpen(target)}
        >
          打开目录
        </Button>
      </div>
    </SettingRow>
  );
}
