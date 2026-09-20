/**
 * 运行期入口解析：Tauri 主进程（生产）与 Vite（开发）走同一套优先级。
 *
 * 9.4.1：生产下 UI 会话 Token 只存内存，由主进程经 initialization_script 注入
 * `window.__ATB_UI_TOKEN__`；开发态由 vite.config.ts 读 `<dataDir>/dev-ui-token` 后构建期注入。
 * Token 绝不进查询参数（13 章产物资源型端点的同一条约束）。
 */

function normalizeBase(value: string | undefined | null): string {
  if (!value) return '';
  const trimmed = value.replace(/\/+$/, '');
  return trimmed.startsWith('http') ? trimmed : `http://${trimmed}`;
}

/** sidecar 基址：注入值 → 构建期常量 → 127.0.0.1:7788（10.3 默认端口）。 */
export function apiBase(): string {
  return (
    normalizeBase(window.__ATB_API_BASE__) ||
    normalizeBase(
      window.__ATB_PORT__ === undefined ? '' : `http://127.0.0.1:${String(window.__ATB_PORT__)}`,
    ) ||
    normalizeBase(import.meta.env?.VITE_ATB_API_BASE) ||
    normalizeBase(typeof __ATB_API_BASE__ === 'string' ? __ATB_API_BASE__ : '') ||
    'http://127.0.0.1:7788'
  );
}

/** 相对路径拼成绝对地址：`<img>`、iframe、pdf.js 只吃绝对 URL（产物签名 URL 已是绝对值）。 */
export function apiUrl(path: string): string {
  if (/^https?:\/\//i.test(path)) return path;
  return `${apiBase()}${path.startsWith('/') ? '' : '/'}${path}`;
}

export function wsUrl(): string {
  return `${apiBase().replace(/^http/, 'ws')}/ws`;
}

/** 本地单用户（v0.0.4 W1a）：不再有账号登录态与 JWT localStorage。UI 会话 Token 是唯一的
 *  前端凭证——旧桌面壳 / CI 注入 `ATB_UI_TOKEN`，取值顺序：内存缓存 → 注入值 → 构建期常量。 */
let cachedToken: string | null = null;

/** 允许 ATB-10 在窗口热重载 / Token 轮换后重新注入，而不必刷新页面。 */
export function setUiToken(token: string): void {
  cachedToken = token;
}

export function uiToken(): string {
  if (cachedToken) return cachedToken;
  const injected = typeof window.__ATB_UI_TOKEN__ === 'string' ? window.__ATB_UI_TOKEN__ : '';
  const fromEnv = typeof import.meta.env?.VITE_ATB_UI_TOKEN === 'string'
    ? (import.meta.env.VITE_ATB_UI_TOKEN as string)
    : '';
  const builtIn = typeof __ATB_UI_TOKEN__ === 'string' ? __ATB_UI_TOKEN__ : '';
  return (injected || fromEnv || builtIn).trim();
}

/** 开发态没起 sidecar / 没读到 dev-ui-token 时给一个可读的提示，而不是让每个请求 401。 */
export function hasUiToken(): boolean {
  return uiToken().length >= 32;
}
