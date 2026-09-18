import { create } from 'zustand';
import { onMustChangePassword, onUnauthorized } from '@/api/client';
import { setUiToken, uiToken, writeLocalAuthToken } from '@/api/env';
import { navigate } from '@/app/router';
import { authApi, type AccountInfo, type LoginResult, type UserCreateInput, type UserPatchInput } from './api';

/**
 * 账号会话 store（0919 三章 / 十六章）。
 *
 * Token 持久化在 localStorage（`atb.auth.token`，env.ts 读取）；账号信息只在内存——
 * 每次进壳用 token 换一次 `GET /auth/me`，账号线上的 status/must_change_password 以
 * 服务端为准（守卫里也是库行重算，不信任旧 token 语义）。
 *
 * 多账号兼容：桌面壳 / e2e 只注入 `ATB_UI_TOKEN`（映射内置 `__local__` 账号），
 * 本地没有登录态时 `uiToken()` 自动回落到注入值，`bootstrap()` 照常走 /auth/me
 * 拿到 `__local__` 的账号信息——老链路「能进壳」的行为不变。
 */

const REMEMBERED_KEY = 'atb.auth.accounts';
const REMEMBERED_MAX = 10;

/** 本机记住过的用户名（只记用户名，绝不存密码——切换账号＝回登录页预填用户名，16.1 拍板）。 */
export function readRememberedUsernames(): string[] {
  try {
    const raw = window.localStorage.getItem(REMEMBERED_KEY);
    const parsed: unknown = raw ? JSON.parse(raw) : [];
    return Array.isArray(parsed) ? parsed.map(String).slice(0, REMEMBERED_MAX) : [];
  } catch {
    return [];
  }
}

function rememberUsername(username: string): void {
  const next = [username, ...readRememberedUsernames().filter((item) => item !== username)];
  try {
    window.localStorage.setItem(REMEMBERED_KEY, JSON.stringify(next.slice(0, REMEMBERED_MAX)));
  } catch {
    // localStorage 不可用时静默：切换账号列表退化为空。
  }
}

function isAuthRoute(): boolean {
  const location = window.location.hash.replace(/^#/, '');
  return location.startsWith('/login') || location.startsWith('/change-password');
}

interface AuthState {
  token: string | null;
  account: AccountInfo | null;
  /** bootstrap 完成前壳层不渲染业务页，避免闪登录页。 */
  ready: boolean;
  bootstrap: () => Promise<void>;
  refreshAccount: () => Promise<AccountInfo | null>;
  login: (username: string, password: string) => Promise<LoginResult>;
  initAdmin: (input: { username: string; password: string; display_name?: string }) => Promise<LoginResult>;
  changePassword: (currentPassword: string, newPassword: string) => Promise<LoginResult>;
  /** 记住的用户名列表（切换账号对话框用）。 */
  remembered: () => string[];
  logout: () => Promise<void>;
  clearSession: () => void;
}

function applySession(result: LoginResult): void {
  setUiToken(result.token);
  writeLocalAuthToken(result.token);
  rememberUsername(result.account.username);
  useAuthStore.setState({
    token: result.token,
    account: { ...result.account, must_change_password: result.must_change_password },
  });
}

export const useAuthStore = create<AuthState>((set, get) => ({
  token: null,
  account: null,
  ready: false,

  async bootstrap() {
    // token 来源优先级在 env.uiToken()：登录态 → 内存缓存 → 注入的 ATB_UI_TOKEN。
    const token = uiToken() || null;
    set({ token });
    if (!token) {
      set({ ready: true });
      return;
    }
    await get().refreshAccount();
    set({ ready: true });
  },

  async refreshAccount() {
    try {
      const account = await authApi.me();
      set({ account });
      return account;
    } catch {
      // 401 = token 失效（onUnauthorized 里已清会话）；网络错误等不误伤本地登录态，
      // 留在匿名态让登录页给出 sidecar 未起的可读提示。
      return null;
    }
  },

  async login(username, password) {
    const result = await authApi.login(username, password);
    applySession(result);
    return result;
  },

  async initAdmin(input) {
    const result = await authApi.init(input);
    applySession(result);
    return result;
  },

  async changePassword(currentPassword, newPassword) {
    const result = await authApi.changePassword(currentPassword, newPassword);
    // 响应是重新签发的 token（旧 token 的 mustChangePassword 语义已过期），直接整体替换。
    applySession(result);
    return result;
  },

  remembered: () => readRememberedUsernames(),

  async logout() {
    // 无状态 JWT：服务端无会话可销毁，返回 ok 即可；失败也不阻止本地登出。
    try {
      await authApi.logout();
    } catch {
      // ignore
    }
    get().clearSession();
  },

  clearSession() {
    writeLocalAuthToken('');
    setUiToken('');
    set({ token: null, account: null });
  },
}));

/** bootstrap 只跑一次：RequireAuth 挂载两份（StrictMode / 多处调用）也只发一次 /auth/me。 */
let bootstrapPromise: Promise<void> | null = null;

export function ensureBootstrap(): Promise<void> {
  bootstrapPromise ??= useAuthStore.getState().bootstrap();
  return bootstrapPromise;
}

// 请求层的两个全局通知在模块加载时接好：401 → 清会话回登录页；
// 403 MUST_CHANGE_PASSWORD → 拉到改密页。登录/改密页自身不重复响应（isAuthRoute 短路）。
onUnauthorized(() => {
  useAuthStore.getState().clearSession();
  if (!isAuthRoute()) navigate('login');
});

onMustChangePassword(() => {
  if (!isAuthRoute() && useAuthStore.getState().token) navigate('changePassword');
});

export type { UserCreateInput, UserPatchInput };
