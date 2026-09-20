import { useCallback, useEffect } from 'react';
import { create } from 'zustand';
import { apiBase } from '@/api';
import { desktop, OPEN_LOG_DIR_CMD } from '@/app/desktop';
import { useToast } from '@/components/ui';

/**
 * 「关于」与「日志与审计」两页要展示的固定运行信息（8.5 关于 / 原型 7.7 / 7.9）。
 *
 * 13 章**没有**任何返回版本、目录、端口的 REST 端点（`GET /settings` 只有 20.9 那 12 个键，
 * 端口明确不进 settings——10.3），所以这份数据只能来自桌面壳：
 * ATB-10 的 Tauri 主进程持有 sidecar 的 `ATB_READY {port,pid,version}` 行（9.4.1 第 4 步）
 * 与平台目录约定，命令名取 `system_info`，返回下面这些 snake_case 键。
 *
 * 浏览器开发态（vite:5173）拿不到这个命令：此时
 * - 端口从 `apiBase()` 反推（就是实际连的那个地址，比猜更准）；
 * - 三个目录退回 9.3 / 20.6 写死的平台默认值，界面上标「按约定值」；
 * - 版本号显示 `—`，**不编一个假版本号**——这一页存在的目的就是说清「我连的是谁」。
 *
 * 这份数据整个会话只取一次（下面的进程内缓存）：三个 Tab 读同一份快照，
 * 而值只在托盘「重启服务」后才变。命令缺失（旧壳）与无壳（开发态）都收敛成
 * `—` + 一行 `reason`，不把 reject 漏给界面变成未捕获异常。
 */
export const SYSTEM_INFO_CMD = 'system_info';
/** `open_dir { target }`，与既有的 `open_log_dir` 同族（2.3 托盘「查看日志」已占用后者）。 */
export const OPEN_DIR_CMD = 'open_dir';

export type DirTarget = 'data' | 'artifacts' | 'logs' | 'backups';

export interface SystemInfo {
  app_version: string | null;
  sidecar_version: string | null;
  port: number | null;
  data_dir: string | null;
  artifacts_dir: string | null;
  logs_dir: string | null;
  backup_dir: string | null;
  /** 路径是否来自平台约定值而非主进程实测（界面据此标「按约定值」）。 */
  dirs_from_convention: boolean;
  /** sidecar 进程是否还活着（主进程实测）；null = 没问到（浏览器开发态或旧壳）。 */
  sidecar_alive: boolean | null;
  /** sidecar pid（10.4 的重启诊断用）；null = 未知。 */
  pid: number | null;
}

type Platform = 'darwin' | 'win32' | 'linux';

function currentPlatform(): Platform {
  const ua = typeof navigator === 'undefined' ? '' : navigator.userAgent;
  if (/Windows/i.test(ua)) return 'win32';
  if (/Mac|iPhone|iPad/i.test(ua)) return 'darwin';
  return 'linux';
}

/** 9.3 + 20.6 的目录约定（Windows 走 %APPDATA%，Linux 日志走 XDG_STATE_HOME）。
 * v0.0.4 W1b（需求.md §21.1）：默认数据目录 `~/.agent-board` → `~/.jarvis-workbench`。 */
function conventionDirs(
  platform: Platform,
): Omit<SystemInfo, 'dirs_from_convention' | 'app_version' | 'sidecar_version' | 'port' | 'sidecar_alive' | 'pid'> {
  if (platform === 'win32') {
    const root = '%APPDATA%\\jarvis-workbench';
    return {
      data_dir: `${root}\\`,
      artifacts_dir: `${root}\\artifacts\\`,
      backup_dir: `${root}\\backups\\`,
      logs_dir: '%APPDATA%\\AgentTaskBoard\\logs',
    };
  }
  if (platform === 'darwin') {
    return {
      data_dir: '~/.jarvis-workbench/',
      artifacts_dir: '~/.jarvis-workbench/artifacts/',
      backup_dir: '~/.jarvis-workbench/backups/',
      logs_dir: '~/Library/Logs/AgentTaskBoard/',
    };
  }
  return {
    data_dir: '~/.jarvis-workbench/',
    artifacts_dir: '~/.jarvis-workbench/artifacts/',
    backup_dir: '~/.jarvis-workbench/backups/',
    logs_dir: '~/.local/state/AgentTaskBoard/logs',
  };
}

/** 监听端口：注入值优先，其次从实际请求基址反推（10.1 只绑 127.0.0.1）。 */
export function listenPort(): number | null {
  const injected = typeof window === 'undefined' ? undefined : window.__ATB_PORT__;
  const parsed = Number(injected);
  if (Number.isInteger(parsed) && parsed > 0) return parsed;
  try {
    const url = new URL(apiBase());
    if (url.port) return Number(url.port);
    return url.protocol === 'https:' ? 443 : 80;
  } catch {
    return null;
  }
}

export function listenAddress(): string {
  const port = listenPort();
  try {
    const url = new URL(apiBase());
    return port ? `${url.hostname}:${port}` : url.host;
  } catch {
    return port ? `127.0.0.1:${port}` : '—';
  }
}

function fallbackInfo(): SystemInfo {
  return {
    app_version: null,
    sidecar_version: null,
    port: listenPort(),
    ...conventionDirs(currentPlatform()),
    dirs_from_convention: true,
    // 进程活没活着只有主进程知道；浏览器开发态用 REST 通不通来判断服务状态（原型 7.9 那一行）。
    sidecar_alive: null,
    pid: null,
  };
}

function merge(injected: Partial<SystemInfo>): SystemInfo {
  const base = fallbackInfo();
  return {
    app_version: injected.app_version ?? base.app_version,
    sidecar_version: injected.sidecar_version ?? base.sidecar_version,
    port: injected.port ?? base.port,
    data_dir: injected.data_dir ?? base.data_dir,
    artifacts_dir: injected.artifacts_dir ?? base.artifacts_dir,
    logs_dir: injected.logs_dir ?? base.logs_dir,
    backup_dir: injected.backup_dir ?? base.backup_dir,
    sidecar_alive: injected.sidecar_alive ?? base.sidecar_alive,
    pid: injected.pid ?? base.pid,
    dirs_from_convention: injected.data_dir ? false : base.dirs_from_convention,
  };
}

export interface SystemInfoView {
  info: SystemInfo;
  /** 主进程是否应答了 `system_info`（false = 浏览器开发态或 ATB-10 未实现该命令）。 */
  fromShell: boolean;
  /**
   * 降级时的一行原因（null = 这份数据就是主进程给的）。
   * 版本与目录仍按 `—` + 约定值渲染；渲染点是 tabs/about.tsx 的页头说明。
   */
  reason: string | null;
}

const BROWSER_REASON = '当前是浏览器开发态：未接入桌面壳，版本号显示 —，目录按 9.3 / 20.6 的约定值。';

function shellReason(message: string): string {
  return `桌面壳没答上 ${SYSTEM_INFO_CMD}：${message}。版本号显示 —，目录按约定值。`;
}

/**
 * `system_info` 的进程内缓存。
 *
 * 「关于」「日志与审计」「备份」三个 Tab 读的是同一份运行信息，原先每个 Tab 各发一次、
 * 每次挂载都重发（实测一次挂载 8 条 `system_info`），而这些值只在托盘「重启服务」后才会变
 * （10.4）。所以全应用只发一次：`inflight` 合并在途请求，`loaded` 挡住后续挂载。
 */
interface SystemInfoCache {
  view: SystemInfoView;
  /** 已经发过一次（成功或降级都算）：不让切 Tab 变成重新问一遍主进程。 */
  loaded: boolean;
}

const useSystemInfoStore = create<SystemInfoCache>(() => ({
  view: { info: fallbackInfo(), fromShell: false, reason: null },
  loaded: false,
}));

let inflight: Promise<SystemInfoView> | null = null;

/** 发一次并按结局收敛成视图：任何失败都不 reject，只把原因写进 `reason`。 */
async function requestSystemInfo(): Promise<SystemInfoView> {
  const outcome = await desktop.tryInvoke<Partial<SystemInfo> | null>(SYSTEM_INFO_CMD);
  if (outcome.kind === 'absent') {
    return { info: fallbackInfo(), fromShell: false, reason: BROWSER_REASON };
  }
  if (outcome.kind === 'error') {
    return { info: fallbackInfo(), fromShell: false, reason: shellReason(outcome.message) };
  }
  const payload = outcome.value;
  if (!payload || typeof payload !== 'object') {
    return { info: fallbackInfo(), fromShell: false, reason: shellReason('主进程回了空载荷') };
  }
  return { info: merge(payload), fromShell: true, reason: null };
}

export function loadSystemInfo(): Promise<SystemInfoView> {
  const state = useSystemInfoStore.getState();
  if (state.loaded || inflight) {
    return inflight ?? Promise.resolve(state.view);
  }
  inflight = requestSystemInfo()
    .then((next) => {
      useSystemInfoStore.setState({ view: next, loaded: true });
      return next;
    })
    .finally(() => {
      inflight = null;
    });
  return inflight;
}

/** 托盘「重启服务」后端口/pid/存活态会变（10.4）：清缓存重取一次。目前无人调用，留给 ATB-10 接线。 */
export function refreshSystemInfo(): Promise<SystemInfoView> {
  inflight = null;
  useSystemInfoStore.setState({ loaded: false });
  return loadSystemInfo();
}

/** 一行降级原因整个会话只提示一次：三个 Tab 同时挂载时不要弹三条。 */
let reasonShown = false;

export function useSystemInfo(): SystemInfoView {
  const view = useSystemInfoStore((state) => state.view);
  const toast = useToast();

  useEffect(() => {
    void loadSystemInfo().then((next) => {
      // 浏览器开发态是预期状态（那一页本来就标了「按约定值」），只在桌面壳里命令失败时才打扰用户。
      if (next.reason === null || !desktop.isDesktop || reasonShown) return;
      reasonShown = true;
      toast.warning('未取到桌面壳运行信息', next.reason);
    });
  }, [toast]);

  return view;
}

const DIR_LABELS: Record<DirTarget, string> = {
  data: '数据目录',
  artifacts: '产物目录',
  logs: '日志目录',
  backups: '备份目录',
};

/**
 * 「打开目录」。浏览器开发态是 no-op——按钮照常可点，点了给一句解释，
 * 而不是禁用了让人以为功能坏了（原型 7.9 的四行都要能点）。
 * 日志行复用托盘那条 `open_log_dir`：同一个目录、两个命令都能开，复用它旧壳上也不缺功能。
 */
export function useOpenDir(): (target: DirTarget) => Promise<void> {
  const toast = useToast();
  return useCallback(
    async (target: DirTarget) => {
      const useTrayCommand = target === 'logs';
      const outcome = useTrayCommand
        ? await desktop.tryInvoke<boolean>(OPEN_LOG_DIR_CMD)
        : await desktop.tryInvoke<boolean>(OPEN_DIR_CMD, { target });
      const label = DIR_LABELS[target];
      if (outcome.kind === 'absent') {
        toast.info(
          `当前是浏览器开发态：打开${label}由桌面壳执行`,
          `命令 ${useTrayCommand ? OPEN_LOG_DIR_CMD : `${OPEN_DIR_CMD} { target: '${target}' }`}`,
        );
        return;
      }
      if (outcome.kind === 'error') {
        toast.error(`打开${label}失败`, outcome.message);
        return;
      }
      // 主进程刻意回布尔而不是抛错（false = 建目录或 `open` 失败），这里把它翻成一句人话。
      if (outcome.value === false) {
        toast.error(`打开${label}失败`, '目录不存在或系统文件管理器拒绝打开；细节见日志目录里的 desktop.log');
      }
    },
    [toast],
  );
}
