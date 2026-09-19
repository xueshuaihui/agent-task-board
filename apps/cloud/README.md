# @atb/cloud — 服务端技能市场服务

可独立部署的服务端市场：云账号注册/登录 + 技能共享全流程（发布、版本、订阅、评分、评论、收藏、举报、反馈闭环）。本期服务端**只做市场与账号**，不含任务/看板。

技术栈与 `apps/api` 一致：NestJS 11 + Prisma 6 + SQLite 起步（`DATABASE_URL`/连接串可换其他 Prisma 支持的库）。市场语义为**个人共享**：登录即可发布，发布即上架（PUBLISHED），无审核环节。

## 快速开始

```bash
# 仓库根目录
npm install
npm run build -w @atb/cloud
npm run start  -w @atb/cloud   # 监听 0.0.0.0:7789
```

开发模式：`npm run dev:cloud`（根目录脚本，nest --watch）。

## 环境变量

| 变量 | 默认值 | 说明 |
| --- | --- | --- |
| `CLOUD_PORT` | `7789` | 监听端口 |
| `CLOUD_DATA_DIR` | `~/.agent-board-cloud`（Windows 为 `%APPDATA%\agent-board-cloud`） | 数据目录，库文件为 `<dir>/cloud.db` |
| `CLOUD_JWT_SECRET` | 无（必须配置） | 登录签发 JWT（HS256）的密钥；未配置时注册/登录返回 500。生产必须显式设置（建议 `openssl rand -hex 32`） |
| `CLOUD_CORS_ORIGINS` | `*` | 允许的跨域来源，逗号分隔；`*` 或未配置时放行任意来源 |
| `CLOUD_MIGRATIONS_DIR` | 自动探测 | 覆盖迁移目录（一般不需要） |
| `CLOUD_SQL_LOG` | 关 | 置 `1` 打印 Prisma 查询日志 |

数据库迁移在启动时自动执行（`prisma/migrations/*.sql`，水位记录在库内 `_cloud_migrations` 表），无需手工步骤。

## Docker 部署

```bash
docker build -t atb-cloud -f apps/cloud/Dockerfile .
docker run -d --name atb-cloud -p 7789:7789 \
  -e CLOUD_JWT_SECRET=<openssl rand -hex 32 的输出> \
  -e CLOUD_CORS_ORIGINS="https://你的桌面端来源,https://你的网页端来源" \
  -v atb-cloud-data:/data \
  atb-cloud
```

镜像基于 `node:20-alpine`，只含编译产物、生产依赖与迁移 SQL。数据卷 `/data` 持久化 `cloud.db`。

## 反向代理建议（nginx/caddy）

- 终止 TLS 后反代到 `127.0.0.1:7789`；市场流量小，`proxy_read_timeout 60s` 足够。
- 请求体上限 ≥ 2MB（服务端 JSON 限额 2MB）。
- 不必透传 `Authorization` 之外的鉴权头；服务端只认 `Authorization: Bearer <JWT>`。
- 建议在生产加一层限速（尤其 `/accounts/register`、`/accounts/login`）。

nginx 示例：

```nginx
location /cloud/ {
  proxy_pass http://127.0.0.1:7789;
  proxy_set_header Host $host;
  proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
  client_max_body_size 4m;
}
```

## 端点清单（前缀 `/cloud/v1`）

### 账号

| 方法 | 路径 | 鉴权 | 说明 |
| --- | --- | --- | --- |
| POST | `/accounts/register` | 匿名 | `{username,password,display_name?}` → `{account,token}`；用户名重复 409 |
| POST | `/accounts/login` | 匿名 | `{username,password}` → `{account,token}`；密码 scrypt 校验 |
| GET | `/accounts/me` | 登录 | 当前账号 |

### 市场（`/market`）

| 方法 | 路径 | 鉴权 | 说明 |
| --- | --- | --- | --- |
| GET | `/market/listings` | 匿名 | 浏览，query：`keyword/category/type/sort=hot\|new\|rating` |
| GET | `/market/listings/:id` | 匿名（可带 token） | 详情含评论；DELISTED 对匿名 404 |
| POST | `/market/publish` | 登录 | 发布 `{name,slug?,description,category,tags,type,license,compatible_clients,content,mcp_dependencies,version}`；重名 slug 自动加 `-2/-3` 后缀，发布即上架 |
| POST | `/market/listings/:id/versions` | 发布者 | 发新版本 `{content,version,changelog}`；所有 SYNCED 订阅行置 HAS_UPDATE |
| POST | `/market/listings/:id/delist` | 发布者 | 下线；订阅行置 DELISTED（快照保留） |
| POST | `/market/listings/:id/subscribe` | 登录 | 订阅，返回快照 `content+version`；重复订阅 = 拉齐最新 |
| GET | `/market/subscriptions` | 登录 | 我的订阅，status：`SYNCED/HAS_UPDATE/DELISTED` |
| POST | `/market/listings/:id/update` | 登录 | 拉新版快照 |
| DELETE | `/market/listings/:id/subscribe` | 登录 | 取消订阅 |
| POST | `/market/listings/:id/rating` | 登录 | 评分 `{score:1..5}`，返回聚合 `{avg,count}` |
| POST | `/market/listings/:id/comments` | 登录 | 评论 `{content}` |
| DELETE | `/market/comments/:commentId` | 作者或 ADMIN | 删除评论 |
| POST | `/market/listings/:id/favorite` | 登录 | 收藏 toggle |
| POST | `/market/listings/:id/report` | 登录 | 举报 `{reason}` |
| POST | `/market/listings/:id/feedback` | 登录 | 反馈 `{title,content}` |
| POST | `/market/feedbacks/:feedbackId/respond` | 发布者 | `{response,resolution:fixed\|wontfix}`；fixed→FIXED_PENDING_VERIFY，wontfix→闭环 |
| POST | `/market/feedbacks/:feedbackId/verify` | 反馈提交者 | `{confirmed}`；true→RESOLVED，false→回 PENDING |
| GET | `/market/me/publishes` / `me/favorites` / `me/feedbacks` | 登录 | 我的发布/收藏/反馈 |

错误响应统一 `{ error: { code, message, ...context } }`，与桌面端 API 同契约（422 校验、401 未登录、403 越权、404 不存在、409 状态冲突）。

## 与桌面端（Agent Task Board）对接

1. 桌面端设置里增加服务端市场服务地址配置 **`ATB_CLOUD_URL`**（如 `https://cloud.example.com`，开发联调 `http://127.0.0.1:7789`）。所有请求以 `${ATB_CLOUD_URL}/cloud/v1` 为根。
2. 注册/登录拿到的 `token` 放在 `Authorization: Bearer <token>`；服务端 JWT 有效期 7 天，过期返回 401（`error.code=UNAUTHORIZED`），桌面端应引导重新登录。
3. 服务端账号与桌面端本地账号相互独立，桌面端需要自行维护「本地身份 ↔ 服务端身份」的绑定映射（建议存 `cloud_account_id`）。
4. CORS：默认 `*`；生产部署时把桌面端 WebView 来源（`tauri://localhost`、`http://tauri.localhost` 等）写入 `CLOUD_CORS_ORIGINS`。
5. 订阅快照（`content` + `snapshot_version`）即技能 JSON，结构与桌面端技能编辑器一致，可直接落地为本地技能。

## 测试

```bash
npm run test -w @atb/cloud   # vitest，HTTP 集成用例（临时 SQLite + 真 HTTP）
```
