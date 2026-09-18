import { http, request } from '@/api/client';

/**
 * 0919 三章账号体系的 DTO 镜像（`apps/api/src/auth/accounts.service.ts`）。
 * 前端不 import 后端包，与 `api/types.ts` 同一条人肉同步约定。
 */
export interface AccountInfo {
  id: string;
  username: string;
  role: string;
  status: string;
  display_name: string | null;
  must_change_password: boolean;
  created_at: string | null;
}

export interface LoginResult {
  token: string;
  account: AccountInfo;
  must_change_password: boolean;
}

export interface UserCreateInput {
  username: string;
  password: string;
  role?: 'ADMIN' | 'MEMBER';
  display_name?: string;
}

export interface UserPatchInput {
  password?: string;
  role?: 'ADMIN' | 'MEMBER';
  status?: 'ACTIVE' | 'DISABLED';
  display_name?: string | null;
}

/** login/init 是 `public` 端点：不带凭证、不做 hasUiToken 前置检查（见 api/client.ts）。 */
export const authApi = {
  login: (username: string, password: string) =>
    request<LoginResult>('POST', '/auth/login', { body: { username, password }, public: true }),
  init: (input: { username: string; password: string; display_name?: string }) =>
    request<LoginResult>('POST', '/auth/init', { body: input, public: true }),
  me: () => http.get<AccountInfo>('/auth/me'),
  changePassword: (current_password: string, new_password: string) =>
    http.post<LoginResult>('/auth/change-password', { current_password, new_password }),
  logout: () => request<{ ok: true }>('POST', '/auth/logout', { body: {}, public: true }),
  listUsers: () => http.get<{ items: AccountInfo[] }>('/auth/users'),
  createUser: (input: UserCreateInput) => http.post<AccountInfo>('/auth/users', input),
  patchUser: (id: string, input: UserPatchInput) =>
    http.patch<AccountInfo>(`/auth/users/${encodeURIComponent(id)}`, input),
};

export function roleLabel(role: string): string {
  return role === 'ADMIN' ? '管理员' : '成员';
}

export function accountLabel(account: AccountInfo): string {
  return account.display_name?.trim() || account.username;
}
