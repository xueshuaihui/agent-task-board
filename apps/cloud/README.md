# @atb/cloud — 服务端技能市场服务

可独立部署的服务端市场：云账号注册/登录 + 技能共享全流程（发布、版本、订阅、评分、评论、收藏、举报、反馈闭环）。本期服务端**只做市场与账号**，不含任务/看板。

技术栈与 `apps/api` 一致：NestJS 11 + Prisma 6 + SQLite 单文件（连接串可换其他 Prisma 支持的库）。市场语义为**个人共享**：登录即可发布，发布即上架（PUBLISHED），无审核环节。

本文分两半：**开发期用法**（§dev）与**生产部署与运维**（§0 起）。生产走离线镜像包，方法论与
`family-ledger` 项目一致：交付物 = 本地打好的镜像 tar 包，服务器只需 Docker + `docker load`。

## 开发期用法

```bash
# 仓库根目录
npm install
npm run build -w @atb/cloud
npm run start  -w @atb/cloud   # 监听 0.0.0.0:7789
```

开发模式：`npm run dev:cloud`（根目录脚本，nest --watch）。测试：`npm run test -w @atb/cloud`（vitest，临时 SQLite + 真 HTTP）。

### 开发环境变量

| 变量 | 默认值 | 说明 |
| --- | --- | --- |
| `CLOUD_PORT` | `7789` | 监听端口 |
| `CLOUD_DATA_DIR` | `~/.agent-board-cloud`（Windows 为 `%APPDATA%\agent-board-cloud`） | 数据目录，库文件为 `<dir>/cloud.db` |
| `CLOUD_JWT_SECRET` | 无（生产必须配置） | 登录签发 JWT（HS256）的密钥；未配置时注册/登录返回 500 |
| `CLOUD_CORS_ORIGINS` | `*` | 允许的跨域来源，逗号分隔；`*` 或未配置时放行任意来源 |
| `CLOUD_MIGRATIONS_DIR` | 自动探测 | 覆盖迁移目录（一般不需要） |
| `CLOUD_SQL_LOG` | 关 | 置 `1` 打印 Prisma 查询日志 |
| `CLOUD_COMMIT` | `unknown` | 构建期注入的 commit 标识，`GET /healthz` 回显（见 §4） |

数据库迁移在启动时自动执行（`prisma/migrations/*.sql`，水位记录在库内 `_cloud_migrations` 表），无需手工步骤，可反复启动。

---

## 0 快速上手（生产）

**交付物是本地打好的离线镜像包**，服务器只要装 Docker：不需要源码、不需要 Node、不需要联网拉镜像。

```bash
# ① 本地打包（产物名固定，覆盖上一版）
bash apps/cloud/deploy/bundle.sh                  # 给 ARM 服务器：PLATFORM=linux/arm64 bash apps/cloud/deploy/bundle.sh

# ② 服务器：包上传到 /opt/agent-task-board-cloud 后，解压进固定目录并起服（首次部署）
mkdir -p /opt/agent-task-board-cloud
tar xzf /opt/agent-task-board-cloud/agent-task-board-cloud-prod.tar.gz --strip-components=1 -C /opt/agent-task-board-cloud
cd /opt/agent-task-board-cloud && ./deploy.sh     # 导入镜像 → 生成 JWT_SECRET → 体检 → 起服 → 探活

# ③ 之后每次发版：上传新包到 /opt/agent-task-board-cloud（覆盖同名）后，一条命令
cd /opt/agent-task-board-cloud && ./deploy.sh update
```

> 命令逐字可复制，不随版本变——**服务端没有版本号**：包名、目录名、镜像 tag 全部固定
> （`agent-task-board-cloud:latest`），回退靠镜像 `:prev` 而不是改版本号（§5）。
> 想知道线上跑的是哪一版：`cat /opt/agent-task-board-cloud/BUILD-INFO.txt`、
> `docker image inspect agent-task-board-cloud:latest --format '{{index .Config.Labels "org.opencontainers.image.revision"}}'`、
> 或 `curl -s https://你的域名/healthz` 的 `commit` 字段。

## 1 目录约定（唯一需要记住的事）

| 位置 | 放什么 | 说明 |
|------|--------|------|
| `/opt/agent-task-board-cloud/` | **运维入口**：`deploy.sh` + `docker-compose.prod.yml` + `Caddyfile` + `.env.prod` + `backups/` + 上传的包 | 持久路径（**不在 /tmp**），所有命令都在这里执行；包上传到本目录后解压（就地覆盖同名） |
| `~/.agent-task-board-cloud/.env.prod` | 配置的稳定副本（保险位，权限 600） | 目录误删后靠它把 `CLOUD_JWT_SECRET` 填回来 |

`CLOUD_JWT_SECRET` 不可再生（换了/丢了所有登录会话失效）：脚本每次体检都往保险位留一份，目录里缺配置时自动回填；另请**再存一份到服务器之外**（`./deploy.sh backup` 的产物同理）。目录被误删时，按 §0 的 ② 解压命令重建、再 `./deploy.sh update` 即恢复——数据在命名卷 `atb-cloud-prod_cloud_data` 里，不受影响。

## 2 拓扑与端口

```
桌面端 / 浏览器 ──https(443/80)──► caddy（自动 HTTPS，独占 80/443，反代到 cloud:7789）
                                    └─► cloud（@atb/cloud，仅绑 127.0.0.1:7789）
                                         ├── /cloud/v1/...   市场 + 账号 API
                                         └── /healthz        探活 {ok,commit}
                                         卷：atb-cloud-prod_cloud_data（/data/cloud.db，SQLite + WAL）
                                    证书卷：caddy_data（重启免重复申请）
```

- 对外只有 caddy 一个入口；宿主机端口只有 `0.0.0.0:80/443`（caddy）与 `127.0.0.1:7789`（cloud 调试口）。
- SQLite 单文件 + WAL，无独立数据库容器；迁移由 cloud 启动时自动执行（幂等），**没有**一次性 migrate 容器。
- 请求体上限：服务端 JSON 限额 2MB，caddy 侧放宽到 4MB。

**变体：80/443 已被别的边缘占用**（1Panel 的 OpenResty 站点、n8n 等）——不要抢端口，改由外部边缘接管：

```bash
# .env.prod
EDGE_MODE=off            # caddy 不进编排；COMPOSE_PROFILES 由脚本自动同步，别手改
```

首次部署（`./deploy.sh`，交互）脚本会先探 80/443，发现被非本编排的进程占着就问一句「改用 `EDGE_MODE=off`？」——答 Y（默认）即自动写入并跳过域名/邮箱提问。此时 `SITE_DOMAIN`/`ACME_EMAIL` 可不填，在既有边缘建站点反代到 `http://127.0.0.1:7789`（即 `HTTP_BIND:HTTP_PORT`），证书由该边缘签发。

## 3 文件与命令

仓库内（都在 `apps/cloud/deploy/`）：

| 文件 | 作用 |
|------|------|
| `bundle.sh` | **本地跑的构建脚本**：构建 cloud 镜像、拉齐 caddy，打成离线包 `dist/agent-task-board-cloud-prod.tar.gz` |
| `docker-compose.prod.yml` | 生产编排（cloud + caddy） |
| `Caddyfile` | 边缘配置（`SITE_DOMAIN`/`ACME_EMAIL` 由环境变量注入） |
| `deploy.sh` | 服务器运维入口（本文所有命令） |
| `.env.prod.example` | 配置模板 |
| `../Dockerfile` | cloud 生产镜像（node:20-alpine，非 root 运行，数据卷 `/data`） |

服务器上的固定目录（§1）：

```
/opt/agent-task-board-cloud/
├── deploy.sh                 运维入口
├── docker-compose.prod.yml   编排（与 Caddyfile 必须同目录：caddy 只读挂载 ./Caddyfile）
├── Caddyfile
├── .env.prod                 配置唯一真身（首次起服自动生成/补齐）
├── backups/                  backup 的落盘位置（BACKUP_DIR 默认相对到这里）
├── BUILD-INFO.txt            打包时的 commit / 时间 / 架构 / 工作区是否干净
└── images/                   包内镜像 tar（首次部署自动 docker load）
```

命令速查（都在 `/opt/agent-task-board-cloud` 里执行）：

| 命令 | 作用 |
|------|------|
| `./deploy.sh` | 首次部署：导入包内镜像 → 生成 JWT_SECRET → 体检 → 起服 → 探活（**唯一**会问域名/邮箱的命令） |
| `./deploy.sh update [包]` | 发版（§5，包路径可省） |
| `./deploy.sh rollback` | 镜像回退：`latest` 与 `:prev` 互换后重新起服（**不回数据**） |
| `./deploy.sh check` | 只做配置体检 |
| `./deploy.sh status` / `logs [服务]` / `down` | 状态与探活 / 跟踪日志（`cloud`/`caddy`）/ 停止（数据卷保留） |
| `./deploy.sh backup` | SQLite 一致性备份（保留最近 `BACKUP_KEEP` 份，默认 14） |
| `./deploy.sh restore [文件] [--yes]` | 用备份恢复库（破坏性，需确认） |

## 4 配置项（`/opt/agent-task-board-cloud/.env.prod`）

| 变量 | 默认 | 说明 |
|------|------|------|
| `CLOUD_JWT_SECRET` | 空→首次部署生成 64 位随机 | JWT 签名密钥；**更换或丢失 = 所有会话失效，不可再生** |
| `CLOUD_CORS_ORIGINS` | 空（`*` 放行任意） | 桌面端 WebView 来源（`tauri://localhost`、`http://tauri.localhost` 等）与网页端来源，逗号分隔 |
| `EDGE_MODE` | `caddy` | `caddy` = 编排自带 caddy 终止 TLS（需 80/443 空闲）；`off` = 外部边缘接管（§2） |
| `COMPOSE_PROFILES` | `edge` | 由脚本按 `EDGE_MODE` 自动同步，**不要手改** |
| `SITE_DOMAIN` / `ACME_EMAIL` | 占位值 | Caddy 自动 HTTPS 的域名与 Let's Encrypt 邮箱；`EDGE_MODE=off` 时可不填 |
| `ACME_CA_BLOCK` | 空 | 测试期填 `acme_ca https://acme-staging-v02.api.letsencrypt.org/directory` 避开生产速率限制 |
| `HTTP_BIND` / `HTTP_PORT` | `127.0.0.1` / `7789` | cloud 容器绑定的地址与端口（调试/健康检查/外部边缘反代目标） |
| `BACKUP_DIR` | `./backups` | 备份落盘目录，建议写绝对路径 |
| `BACKUP_KEEP` | `14` | 备份保留份数 |

改完怎么生效：

| 改了什么 | 怎么生效 |
|----------|----------|
| `EDGE_MODE` | 重跑 `./deploy.sh update`（脚本同步 `COMPOSE_PROFILES` 并决定 caddy 是否起服） |
| 端口 / 域名 / 邮箱 / 备份目录 | `docker compose up -d` |
| `CLOUD_JWT_SECRET` | 同上；更换后所有会话失效，全员重新登录 |

健康端点：`GET /healthz`（无需鉴权）返回 `{ok:true, commit}`，`commit` 来自镜像构建期注入的 `GIT_REVISION`（bundle.sh 打包时写入），与包内 `BUILD-INFO.txt` 一致。

## 5 发版与回退

上传新包到 `/opt/agent-task-board-cloud` 后：`cd /opt/agent-task-board-cloud && ./deploy.sh update`（包路径可省：在候选目录里取 mtime 最新的 `agent-task-board-cloud*.tar.gz`；刻意不扫 `images/`）。

`update` 按顺序做六件事（**全程无交互**）：

1. **先把在跑的镜像留成 `:prev`**——必须在导入新镜像之前做，否则 latest 被占走后旧镜像再也切不回去。
2. `docker load` 新镜像 → `latest` 指向它（服务器不需要源码与网络）。
3. **同步包内配置**：`docker-compose.prod.yml` / `Caddyfile` / 已知 `.env` 键（只补缺失，绝不覆盖密钥与域名）；覆盖前留 `<文件>.bak-<时间戳>`，差异 `diff -u` 打到终端。
4. **升级前自动备份 SQLite**（VACUUM INTO 一致性快照，落 `backups/`）；失败即中止更新、服务器零变更。
5. 体检 → `up -d`（启动时自动执行迁移，幂等）→ 轮询 `/healthz` 探活。
6. 追加一条「时间 / 旧镜像ID → 新镜像ID / 构建标识 / 备份文件」到 `update-history.log`。

**回退**：`./deploy.sh rollback` 把 `latest` 与 `:prev` 互换后重新起服——是互换而不是单向，再跑一次就切回来。只回镜像**不回数据**：迁移均为加表加列式，新结构对旧代码前向兼容；数据要回到升级前时点用 `./deploy.sh restore <升级前的备份> --yes`。`:prev` 是唯一的回退手段，**别删**。

## 6 备份与恢复

```bash
cd /opt/agent-task-board-cloud
./deploy.sh backup                          # VACUUM INTO 快照 → gzip → backups/cloud-<时间戳>.db.gz，保留 14 份
./deploy.sh restore [文件] [--yes]          # 用备份覆盖库（破坏性：先停服、覆盖 cloud.db、清 WAL 后起服）
```

备份用 cloud 镜像自带的 node + Prisma 执行 `VACUUM INTO`（在线一致性快照，不怕 WAL），服务器不需要装 sqlite3。定时备份（crontab，用户 root）：

```bash
30 3 * * * cd /opt/agent-task-board-cloud && ./deploy.sh backup >> backups/backup.log 2>&1
```

再落异地：对 `backups/` 直接 rsync / rclone，或用面板的对象存储同步。数据全在 `atb-cloud-prod_cloud_data` 一个卷里（`/data/cloud.db`），无其他状态。

## 7 桌面端对接配置

1. 桌面端设置里的服务端市场地址 **`ATB_CLOUD_URL`** 指向本服务域名，如 `https://cloud.example.com`（开发联调 `http://127.0.0.1:7789`）。所有请求以 `${ATB_CLOUD_URL}/cloud/v1` 为根。
2. 注册/登录拿到的 `token` 放在 `Authorization: Bearer <token>`；JWT 有效期 7 天，过期返回 401（`error.code=UNAUTHORIZED`），桌面端应引导重新登录。
3. 服务端账号与桌面端本地账号相互独立，桌面端自行维护「本地身份 ↔ 服务端身份」的绑定映射（建议存 `cloud_account_id`）。
4. CORS：桌面端 WebView 经公网域名直连服务端（不同源），需把 `tauri://localhost`、`http://tauri.localhost` 等来源写入 `CLOUD_CORS_ORIGINS`。
5. 订阅快照（`content` + `snapshot_version`）即技能 JSON，结构与桌面端技能编辑器一致，可直接落地为本地技能。

## 8 端点清单（前缀 `/cloud/v1`）

### 健康检查

| 方法 | 路径 | 鉴权 | 说明 |
| --- | --- | --- | --- |
| GET | `/healthz` | 匿名 | `{ok:true, commit}`；探活与版本核对（§0） |

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

## 9 验收清单

- [ ] `./deploy.sh check` 通过，且打印「交付模式：离线镜像」
- [ ] `docker ps`：caddy 占 `0.0.0.0:80/443`（EDGE_MODE=caddy 时）；cloud 只有 `127.0.0.1:7789->7789`
- [ ] `docker volume ls` 有 `atb-cloud-prod_cloud_data` 与 `atb-cloud-prod_caddy_data`
- [ ] `curl -s https://你的域名/healthz` 的 `commit` 与 `BUILD-INFO.txt` 一致；`http://` 自动跳 `https://`
- [ ] 桌面端配置 `ATB_CLOUD_URL` 后走完：注册 → 发布技能 → 另一账号订阅 → 评分/评论
- [ ] 演练过一次 `./deploy.sh update` 与一次 `./deploy.sh rollback`
- [ ] `~/.agent-task-board-cloud/.env.prod` 副本存在，且最近一次备份已存到**服务器之外**
- [ ] 完整演练过一次 `backup` → `restore`（没被恢复验证过的备份不算备份）
