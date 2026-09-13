/**
 * 桌面能力适配层（9.4.2 的 Tauri IPC 通道）。
 *
 * 约定：**只有这个文件允许触碰 Tauri 运行时**，其他代码一律 `import { desktop } from '@/app/desktop'`。
 * 理由有二：
 * 1. 浏览器开发态（vite:5173）没有主进程，`@tauri-apps/*` 的每个调用都会抛，
 *    散在各组件里的 `try/catch` 会变成不可测的噪声；
 * 2. 换 Tauri 版本或改 invoke 命令名时，只改这一处。
 *
 * 这里不 import `@tauri-apps/api`：该包不在 apps/web 的依赖里（阶段一的窗口/托盘由 ATB-10 的
 * Rust 侧与 tauri 配置承担），运行期通过 `window.__TAURI__.core.invoke` 探测——
 * 需要 ATB-10 在 tauri 配置里打开 `app.withGlobalTauri = true`。
 */

/**
 * `invoke` 的三种结局，区别只在「该不该降级」：
 * - `ok`：主进程应答了（值本身可能是 `false` / 空串，那是业务结果，不是失败）；
 * - `absent`：不在桌面壳里（vite:5173 的浏览器开发态），调用方走降级分支；
 * - `error`：在桌面壳里但命令报错，**最常见的是主进程版本比界面旧**（命令没注册）。
 */
export type InvokeOutcome<T> =
  | { kind: 'ok'; value: T }
  | { kind: 'absent' }
  | { kind: 'error'; message: string };

export type Invoke = (cmd: string, args?: Record<string, unknown>) => Promise<unknown>;

/** 2.3 托盘「查看日志」的命令名：由这个文件持有，`system-info.ts` 也复用同一个常量。 */
export const OPEN_LOG_DIR_CMD = 'open_log_dir';

export interface DesktopCapability {
  /** 是否真的跑在 Tauri 主窗口里（false = 浏览器开发态）。 */
  readonly isDesktop: boolean;
  /** 未接桌面能力时返回 null，调用方据此走降级分支而不是抛错。 */
  invoke: <T = unknown>(cmd: string, args?: Record<string, unknown>) => Promise<T | null>;
  /**
   * `invoke` 的可辨结局版：命令在主进程里报错时**不会 reject**，而是回 `{ kind: 'error' }`，
   * 调用方因此能区分「没桌面壳」和「有壳但这个命令没实现」，并给出一行原因（8.5「关于」用）。
   */
  tryInvoke: <T = unknown>(cmd: string, args?: Record<string, unknown>) => Promise<InvokeOutcome<T>>;
  /** 2.3 托盘角标与顶栏铃铛同源；浏览器开发态没有托盘，no-op。 */
  setTrayBadge: (count: number) => Promise<void>;
  /** 15 章：`link` 产物点击交系统默认浏览器，WebView 不导航过去。 */
  openExternal: (url: string) => Promise<void>;
  copyText: (text: string) => Promise<void>;
  /** 2.1 关闭按钮 = 隐藏到托盘，窗口不销毁。 */
  hideWindow: () => Promise<void>;
  showWindow: () => Promise<void>;
  /** 2.3「查看日志」：用系统文件管理器打开日志目录。 */
  openLogDir: () => Promise<void>;
  /** 6.12.1 导出落地：原生保存对话框，浏览器退回 `<a download>`。 */
  saveTextFile: (filename: string, contents: string) => Promise<void>;
}

const isDesktop =
  typeof window !== 'undefined' &&
  (('__TAURI_INTERNALS__' in window || '__TAURI__' in window) ||
    navigator.userAgent.includes('Tauri'));

function rawInvoke(): Invoke | null {
  if (typeof window === 'undefined') return null;
  const candidate = window.__TAURI__?.core?.invoke;
  return typeof candidate === 'function' ? (candidate as Invoke) : null;
}

/** Tauri 的 reject 值是个裸字符串（`Command x not found` / Rust 侧的 Err 文本），也可能是 Error。 */
function normalizeError(cmd: string, error: unknown): string {
  const raw =
    typeof error === 'string'
      ? error
      : error instanceof Error
        ? error.message
        : String(error ?? '未知错误');
  const detail = raw.trim() || '未知错误';
  if (/not found|unknown command/i.test(detail)) return `桌面壳未注册命令 ${cmd}（主进程版本早于界面）`;
  return `${cmd}：${detail}`;
}

/** 唯一碰 `invoke` 的地方：三种结局都在此收敛，绝不向外抛——`call` 的降级约定不该被 reject 打破。 */
async function attempt<T>(cmd: string, args?: Record<string, unknown>): Promise<InvokeOutcome<T>> {
  const invoke = rawInvoke();
  if (!invoke) {
    if (import.meta.env.DEV) console.debug(`[desktop] 非桌面环境，忽略命令 ${cmd}`);
    return { kind: 'absent' };
  }
  try {
    return { kind: 'ok', value: (await invoke(cmd, args)) as T };
  } catch (error) {
    const message = normalizeError(cmd, error);
    console.warn(`[desktop] ${message}`);
    return { kind: 'error', message };
  }
}

/** 主进程没实现的命令：开发态打一条 warn 就返回，不让界面因为缺桌面能力而白屏。 */
async function call<T>(cmd: string, args?: Record<string, unknown>): Promise<T | null> {
  const outcome = await attempt<T>(cmd, args);
  // error 与 absent 都回 null：调用方现有的降级分支（window.open / 剪贴板 / `<a download>`）正是我们要的兜底。
  return outcome.kind === 'ok' ? outcome.value : null;
}

export const desktop: DesktopCapability = {
  isDesktop,
  invoke: <T,>(cmd: string, args?: Record<string, unknown>) => call<T>(cmd, args),
  tryInvoke: <T,>(cmd: string, args?: Record<string, unknown>) => attempt<T>(cmd, args),

  setTrayBadge: async (count) => {
    await call('tray_set_badge', { count });
  },

  openExternal: async (url) => {
    if (!/^https?:\/\//i.test(url)) return;
    const opened = await call<boolean>('open_external', { url });
    // 开发态没有主进程时退回 window.open；仍是新标签，但不影响本机链接的可点性。
    if (opened === null) window.open(url, '_blank', 'noopener,noreferrer');
  },

  copyText: async (text) => {
    const done = await call<boolean>('clipboard_write', { text });
    if (done === null) {
      try {
        await navigator.clipboard?.writeText(text);
      } catch {
        /* WebView 无剪贴板权限时静默：调用方自己决定要不要提示「已复制」失败 */
      }
    }
  },

  hideWindow: async () => {
    await call('window_hide');
  },
  showWindow: async () => {
    await call('window_show');
  },
  openLogDir: async () => {
    await call(OPEN_LOG_DIR_CMD);
  },

  saveTextFile: async (filename, contents) => {
    const saved = await call<string>('save_text_file', { filename, contents });
    if (saved === null) downloadViaAnchor(filename, contents);
  },
};

function downloadViaAnchor(filename: string, contents: string): void {
  const url = URL.createObjectURL(new Blob([contents], { type: 'application/json' }));
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = filename;
  anchor.click();
  URL.revokeObjectURL(url);
}

/**
 * 2.1：禁用 WebView 默认右键菜单与文本选择（输入框、代码区除外）。
 * 只在生产装载——开发态要右键检查元素，禁掉等于自断调试。
 */
export function installWebViewGuards(): void {
  if (import.meta.env.DEV) return;
  window.addEventListener(
    'contextmenu',
    (event) => {
      const target = event.target as HTMLElement | null;
      if (target?.closest('input, textarea, [data-selectable], pre, code')) return;
      event.preventDefault();
    },
    { capture: true },
  );
}

/**
 * 描述里的裸 URL 会渲染成 `<a target="_blank">`（`features/task-detail/rich-text.tsx`），
 * 而壳只给了 `core:default`——Tauri 2 拒绝 WebView 自己建新窗口，打包后点这类链接是**静默失效**。
 * 这里代理一次，把 http(s) 的 href 交系统默认浏览器（6.10.1：不由 WebView 导航）。
 * hash 路由的 `<a href="#/...">` 不匹配，因此不经过这里。
 */
export function installExternalLinkGuard(): void {
  // 开发态浏览器原生就能开新标签；抢过来反而要 await 才 window.open，会被弹窗拦截。
  if (import.meta.env.DEV) return;
  window.addEventListener('click', (event) => {
    if (event.defaultPrevented || event.button !== 0) return;
    const anchor = (event.target as HTMLElement | null)?.closest('a');
    if (!anchor) return;
    const href = anchor.getAttribute('href') ?? '';
    if (!/^https?:\/\//i.test(href)) return;
    event.preventDefault();
    void desktop.openExternal(href).catch(() => undefined);
  });
}

/**
 * 2.1：窗口内导航不出现浏览器前进后退——拦截后退键与鼠标侧键。
 * hash 路由本身可后退，所以这里只挡键盘/手势的「离开应用」路径。
 */
export function installNavigationGuards(): void {
  window.addEventListener('keydown', (event) => {
    if (event.altKey && (event.key === 'ArrowLeft' || event.key === 'ArrowRight')) {
      event.preventDefault();
    }
    if (event.key === 'F5' || (event.metaKey && event.key.toLowerCase() === 'r')) {
      // 生产态刷新会丢内存里的 UI Token（9.4.1 只存内存），交给主进程决定；开发态放行给 Vite HMR。
      if (!import.meta.env.DEV) event.preventDefault();
    }
  });
}
