# 账号体系 UI（0919 三章 / 2.3 / 十六章）

对接 `apps/api/src/auth/*` 的账号端点：`login / init / me / change-password / logout / users(三件套)`。

## 文件

- `api.ts` — 端点封装与 DTO 镜像；`login/init/logout` 走 `public` 请求（不带凭证）。
- `store.ts` — Zustand 会话 store：token 存 localStorage（`atb.auth.token`，由 `api/env.ts` 的
  `uiToken()` 统一解析），账号信息只在内存，进壳用 `GET /auth/me` 换取。
  另在本模块挂了两个请求层监听：401 → 清会话回登录页；403 `MUST_CHANGE_PASSWORD` → 拉到改密页。
- `require-auth.tsx` — 认证守卫（`app.tsx` 中包住工作区壳）。
- `login-page.tsx` — 登录页 + 首次初始化管理员表单（3.1 / 3.3）。
- `change-password-page.tsx` — 首登强制改密页（3.2），成功后用响应中的新 token 继续。
- `account-menu.tsx` — 顶栏账号下拉（2.3）：账号信息 / 切换账号 / 修改密码 / ADMIN 的用户管理 / 退出登录。
- `switch-account-dialog.tsx` — 切换账号（16.1）。
- `user-manage-dialog.tsx` — 用户管理（列表 / 创建 / 重置密码 / 禁用启用）。

## 次级决策（现有接口能支撑的最优实现）

1. **是否需要初始化无法自动探测**：后端没有公开的 `/auth/status`；`/auth/me` 无凭证恒 401、
   `/auth/users` 需要 ADMIN 会话，都区分不出「库为空」。因此登录页默认登录表单 +
   「首次使用？初始化管理员账号」切换；`init` 对已存在账号返回 403（「已存在账号，初始化接口已关闭」），
   页面捕获后自动切回登录表单并展示原因。
2. **切换账号不存密码**：本机只记住用户名（`atb.auth.accounts`，最多 10 个）。「切换」＝
   登出当前会话 → 回登录页预填用户名，密码由用户输入（16.1 拍板决策）。
3. **改密页保留「当前密码」字段**：原型 3.2 只画了新密码，但后端 `change-password`
   必须校验 `current_password`，故表单含当前 / 新 / 确认三项。
4. **401 全局跳登录**：任何业务请求 401（token 失效、sidecar 重启换 token）即清会话回登录页；
   登录/改密页自身不响应（避免表单错误也触发跳转）。
5. **旧 `ATB_UI_TOKEN` 兼容**：本地无登录态时 `uiToken()` 回落到注入值（内置 `__local__` 账号），
   `bootstrap` 照常走 `/auth/me`，桌面壳 / e2e 行为不变；登录产生的 JWT 优先于注入值。
