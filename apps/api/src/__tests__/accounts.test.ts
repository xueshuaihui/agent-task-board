import { afterAll, describe, expect, it } from 'vitest';
import { createTestApp, errorCode, request, type Sender, type TestApp } from './helpers/http-app';
import { API, anonSender, newTask, uiSender } from './helpers/seed';

/**
 * 0919 账号体系：init 一次性、login、JWT 会话、首登强制改密、admin 用户管理、
 * ATB_UI_TOKEN 兼容路径、按账号的数据隔离。
 */
describe('账号体系', () => {
  let t: TestApp;

  afterAll(async () => {
    if (t) await t.close();
  });

  it('无任何账号时 POST /auth/init 创建首个 ADMIN（仅一次）', async () => {
    t = await createTestApp();
    const anon = anonSender(t);

    const res = await anon.post(`${API}/auth/init`, {
      username: 'admin',
      password: 'secret66',
      display_name: '管理员',
    });
    expect(res.status).toBe(201);
    expect(res.body.token).toBeTypeOf('string');
    expect(res.body.account.role).toBe('ADMIN');
    expect(res.body.must_change_password).toBe(false);

    // 已有账号后永久关闭
    const again = await anon.post(`${API}/auth/init`, { username: 'eve', password: 'secret66' });
    expect(again.status).toBe(403);

    const me = await request(t, res.body.token).get(`${API}/auth/me`);
    expect(me.status).toBe(200);
    expect(me.body.username).toBe('admin');
  });

  it('login 成功/失败；错误密码 401', async () => {
    const anon = anonSender(t);
    const ok = await anon.post(`${API}/auth/login`, { username: 'admin', password: 'secret66' });
    expect(ok.status).toBe(201);
    const bad = await anon.post(`${API}/auth/login`, { username: 'admin', password: 'wrong!' });
    expect(bad.status).toBe(401);
    expect(errorCode(bad)).toBe('UNAUTHORIZED');
  });

  it('admin 建 MEMBER：首登强制改密（其他接口 403 MUST_CHANGE_PASSWORD），改密后放行', async () => {
    const admin = await login(t, 'admin', 'secret66');
    const created = await admin.post(`${API}/auth/users`, {
      username: 'member1',
      password: 'first66',
    });
    expect(created.status).toBe(201);
    expect(created.body.must_change_password).toBe(true);

    const firstLogin = await anonSender(t).post(`${API}/auth/login`, { username: 'member1', password: 'first66' });
    expect(firstLogin.body.must_change_password).toBe(true);
    const member = request(t, firstLogin.body.token);
    // 首登：me/change-password 可用，业务接口被拒
    expect((await member.get(`${API}/auth/me`)).status).toBe(200);
    const blocked = await member.get(`${API}/tasks`);
    expect(blocked.status).toBe(403);
    expect(errorCode(blocked)).toBe('MUST_CHANGE_PASSWORD');

    const changed = await member.post(`${API}/auth/change-password`, {
      current_password: 'first66',
      new_password: 'second77',
    });
    expect(changed.status).toBe(201);
    expect(changed.body.must_change_password).toBe(false);

    const unblocked = request(t, changed.body.token);
    expect((await unblocked.get(`${API}/tasks`)).status).toBe(200);

    // 旧密码不能再登录，新密码可以
    expect((await anonSender(t).post(`${API}/auth/login`, { username: 'member1', password: 'first66' })).status).toBe(401);
    expect((await anonSender(t).post(`${API}/auth/login`, { username: 'member1', password: 'second77' })).status).toBe(201);
  });

  it('users 管理三件套：MEMBER 403；重置密码/禁用/改角色', async () => {
    const admin = await login(t, 'admin', 'secret66');
    const member = await login(t, 'member1', 'second77');

    expect((await member.get(`${API}/auth/users`)).status).toBe(403);
    expect((await member.post(`${API}/auth/users`, { username: 'xxx2', password: 'aaaaaa' })).status).toBe(403);

    const users = await admin.get(`${API}/auth/users`);
    expect(users.status).toBe(200);
    const memberRow = users.body.items.find((row: any) => row.username === 'member1');

    // 重置密码 → mustChangePassword
    const reset = await admin.patch(`${API}/auth/users/${memberRow.id}`, { password: 'reset88' });
    expect(reset.status).toBe(200);
    expect(reset.body.must_change_password).toBe(true);
    const relogin = await anonSender(t).post(`${API}/auth/login`, { username: 'member1', password: 'reset88' });
    expect(relogin.body.must_change_password).toBe(true);

    // 禁用后登录 403，旧 token 也不能用
    expect((await admin.patch(`${API}/auth/users/${memberRow.id}`, { status: 'DISABLED' })).status).toBe(200);
    expect((await anonSender(t).post(`${API}/auth/login`, { username: 'member1', password: 'reset88' })).status).toBe(403);
    const disabledToken = relogin.body.token;
    expect((await request(t, disabledToken).get(`${API}/auth/me`)).status).toBe(401);

    // 内置账号不可见不可改
    const list = await admin.get(`${API}/auth/users`);
    expect(list.body.items.some((row: any) => row.username === '__local__')).toBe(false);
  });
});

describe('ATB_UI_TOKEN 兼容路径', () => {
  it('uiToken 仍可调 UI 接口、调 Agent 接口被拒', async () => {
    const app = await createTestApp();
    try {
      const ui = uiSender(app);
      expect((await ui.get(`${API}/auth/me`)).status).toBe(200);
      expect((await ui.get(`${API}/auth/me`)).body.username).toBe('__local__');
      // 兼容账号不进 /auth/users 列表，但登录接口不可用（无密码）
      expect((await anonSender(app).post(`${API}/auth/login`, { username: '__local__', password: 'x' })).status).toBe(401);
    } finally {
      await app.close();
    }
  });
});

async function login(app: TestApp, username: string, password: string): Promise<Sender> {
  const res = await anonSender(app).post(`${API}/auth/login`, { username, password });
  if (res.status !== 201) throw new Error(`登录失败：${res.status} ${res.text}`);
  return request(app, res.body.token);
}

export { login as loginAs };
