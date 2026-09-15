# Agent Task Board

本地桌面任务看板：**人建任务，Agent 经 MCP / REST 认领执行，结果强制人工审核。**

整个应用以桌面客户端形态运行在用户本机：前端在 Tauri 主窗口内渲染，业务逻辑全部由本地托管的 Node sidecar 提供，数据保存在本地 SQLite 文件，不依赖任何远端服务。

- 主仓库：`agent-task-board`（npm workspaces monorepo，Node ≥ 20）
- 包名：`@atb/web`（前端）、`@atb/api`（后端 sidecar）、`@atb/desktop`（桌面壳）

---

## 架构总览

```
┌──────────────┐      ┌───────────────────────────┐      ┌─────────────────┐
│   @atb/web   │      │  @atb/desktop (Tauri 2)   │      │  外部 Agent     │
│ React + Vite │◄─────┤  窗口 / 托盘 / 单实例     │◄─────┤  MCP / REST     │
│  主窗口 UI   │ REST │  Rust 壳（不承载业务数据）│      │  认领并执行任务 │
└──────────────┘      └─────────────┬─────────────┘      └─────────────────┘
                                    │ 托管 sidecar 子进程
                                    ▼
                          ┌───────────────────────────┐
                          │   @atb/api (NestJS 11)    │
                          │  REST + MCP + WebSocket   │
                          │  仅监听 127.0.0.1         │
                          │  Prisma 6 + SQLite（本地）│
                          └───────────────────────────┘
```

**边界原则**

- 桌面壳（`@atb/desktop`）只负责窗口、托盘、单实例、系统对话框与 sidecar 进程托管，**不承载任何业务数据**；所有读写均经过 sidecar 的 REST（见 `apps/desktop/src-tauri/Cargo.toml` 注释与 `apps/desktop/src-tauri/src/sidecar.rs`）。
- API sidecar 仅绑定 `127.0.0.1`，不对外暴露端口（见 `apps/api/src/main.ts` 与 `apps/api/package.json` 描述）。
- Agent 通过 MCP 与 REST 两种通道接入，任务产出物经人工审核后才生效。

---

## 技术栈

| 应用 | 技术 | 说明 |
| --- | --- | --- |
| `@atb/web` | React 18 + Vite 6 + Tailwind 4 | Tauri 主窗口前端；`@dnd-kit` 拖拽、`@tanstack/react-query` 数据、`zustand` 状态、`lucide-react` 图标 |
| `@atb/api` | NestJS 11 + Prisma 6 + SQLite | 本地 sidecar；REST + MCP（`@modelcontextprotocol/sdk`）+ WebSocket（`ws`）；`zod` 校验、`winston` 日志审计 |
| `@atb/desktop` | Tauri 2 + Rust | 桌面壳，无 npm 依赖；`arboard` 剪贴板、`tauri-plugin-single-instance`、`tauri-plugin-dialog` |

---

## 目录结构

```
agent-task-board/
├── apps/
│   ├── api/          # @atb/api — NestJS sidecar（REST/MCP/WS + SQLite）
│   │   └── src/
│   │       ├── tasks/        # 任务 CRUD、过滤、状态流转
│   │       ├── artifacts/    # 产出物存储、签名资源、diff
│   │       ├── auth/         # 作用域与鉴权守卫
│   │       ├── field-defs/   # 自定义字段定义
│   │       ├── settings-api/ # 设置接口
│   │       ├── contract/     # 共享契约（schema/enums/transitions/ids）
│   │       ├── infra/        # Prisma、事件、通知、审计、日志
│   │       └── main.ts
│   ├── web/          # @atb/web — React 主窗口前端
│   │   └── src/
│   │       ├── api/    app/    components/    features/
│   │       ├── lib/    styles/    ws/    main.tsx
│   └── desktop/       # @atb/desktop — Tauri 2 桌面壳（Rust）
│       └── src-tauri/
│           ├── src/    # main / window / tray / sidecar / commands / state / diag ...
│           └── Cargo.toml
├── docs/            # 产品与设计文档、高保真原型（见下）
├── package.json     # 根 workspaces 与聚合脚本
└── README.MD
```

---

## 环境要求

- **Node.js ≥ 20**（根 `package.json` 的 `engines`）
- **Rust 工具链**（仅桌面端构建需要）：`cargo` 需在 `PATH` 中，构建前执行 `export PATH="$HOME/.cargo/bin:$PATH"`
- **npm**（使用 workspaces，无需 pnpm/yarn）
- **`@tauri-apps/cli@2`**（仅打包 `.app/.dmg` 时需要，已列为根 devDependency，随 `npm install` 自动安装；仅 `desktop:build` 出裸二进制则不需要）

---

## 快速开始（开发模式）

```bash
# 1. 安装依赖（根目录，一次性）
npm install

# 2. 初始化本地数据库（Prisma + SQLite）
npm run prisma          # 执行 apps/api/scripts/db.mjs

# 3. 启动后端 sidecar（监听 127.0.0.1）
npm run dev:api

# 4. 启动前端（Vite 开发服务器 / Tauri 主窗口）
npm run dev:web
```

---

## 构建与打包

> 构建顺序不能乱：`@atb/api` 和 `@atb/web` 必须先于桌面壳构建。
> `build.rs` 在编译期把 api 入口注入二进制（`ATB_DEV_SIDECAR_ENTRY`），
> Tauri 在编译期把 `web/dist` 嵌入二进制（`frontendDist`）。两者都依赖先有产物。

### 1. 仅构建（不打包安装包）

```bash
npm run build           # = nest build (api) && tsc -b && vite build (web)
npm run desktop:build   # cargo build --release → 裸二进制 atb-desktop
```

直接运行裸二进制：

```bash
./apps/desktop/src-tauri/target/release/atb-desktop
```

### 2. 打包 macOS .app / .dmg（可独立分发）

`@tauri-apps/cli@2` 已作为根 devDependency 安装（随 `npm install` 落地），提供 `tauri build`。
`.app` 会把 web UI（编译期嵌入）、api sidecar（`Resources/sidecar/main.js`）与 node 运行时
（`Resources/sidecar/node`）一起打包，**从 Finder 双击即可独立运行**。

**前置：把 node 运行时拷进打包资源**
> 本机只有 WorkBuddy 托管的 node，不在 GUI 默认 PATH；
> 从 Finder 启动的 `.app` 若找不到 `node`，整个后端 sidecar 起不来。
> `tauri.conf.json` 的 `bundle.resources` 已声明 `resources/sidecar/node`，
> 但该文件需手动放入（不入库，约 110 MB）。**缺失会直接导致 `tauri build` 报错。**

```bash
# 拷贝 node 二进制（需与 release 二进制同架构：当前为 x86_64）
mkdir -p apps/desktop/src-tauri/resources/sidecar
cp /绝对路径/node apps/desktop/src-tauri/resources/sidecar/node
```

**打包：**

```bash
cd apps/desktop/src-tauri
export PATH="$HOME/.cargo/bin:$PATH"
npx tauri build     # .app 产出在 target/release/bundle/macos/
```

**生成 .dmg（绕过 create-dmg 的 osascript 依赖）**
> `tauri build` 自带的 `bundle_dmg.sh` 依赖 `osascript` 摆 Finder 窗口，
> 在无头 / 沙箱会话下必失败。改用 `hdiutil` 直接压缩：

```bash
cd apps/desktop/src-tauri/target/release/bundle
hdiutil create -volname "Agent Task Board" \
  -srcfolder "macos/Agent Task Board.app" -ov -format UDZO \
  "dmg/Agent Task Board_0.1.0_x64.dmg"
```

产物：
- `.app`：`target/release/bundle/macos/Agent Task Board.app`（自包含，含 sidecar + node）
- `.dmg`：`target/release/bundle/dmg/Agent Task Board_0.1.0_x64.dmg`（UDZO 压缩）

### 运行须知（签名与 Gatekeeper，无证书降级方案）

**当前发布口径：未签名（本机无 Apple Developer 证书，阶段一按降级方案交付）。**

- **首次打开被 Gatekeeper 拦截**是预期行为，两种解除方式：
  1. 右键 `.app` →「打开」→ 再点「打开」（弹窗确认一次即可，之后正常启动）；
  2. 终端执行 `xattr -cr "/path/Agent Task Board.app"` 清除隔离属性后双击。
- `.dmg` 本身下载/拷贝不受影响，拦截发生在首次运行 `.app` 时。
- **x86_64 架构**：当前 release 二进制为 x86_64，在 Apple Silicon 上走 Rosetta（可用，但非性能最优）。

**arm64 原生构建（Apple Silicon 机器上执行）：**

```bash
# 1. 添加 arm64 Rust 目标
rustup target add aarch64-apple-darwin

# 2. 准备 arm64 版 node 二进制（不能用当前的 x86_64 node！）
#    任一来源均可：官方 nodejs.org arm64 pkg / Homebrew / 已有安装，
#    拷到打包资源路径（tauri.conf.json resources 声明的位置）：
mkdir -p apps/desktop/src-tauri/resources/sidecar
cp /path/to/arm64-node apps/desktop/src-tauri/resources/sidecar/node

# 3. 指定目标架构构建
cd apps/desktop/src-tauri
export PATH="$HOME/.cargo/bin:$PATH"
npx tauri build --target aarch64-apple-darwin
# 产物在 target/aarch64-apple-darwin/release/bundle/macos/
```

**通用二进制（Universal 2，双架构单包）**：`npx tauri build --target universal-apple-darwin`。
注意：node 侧也要是 universal 二进制（用 `lipo -create x86_64-node arm64-node -output node` 合成），
否则 Rosetta 缺失的环境（如全新 arm64 机器未装 Rosetta）里 sidecar 起不来。两套架构的 node 都要备齐。

> ⚠️ `resources/sidecar/node` 不入库（.gitignore 已覆盖），每次打包前按当前目标架构重新拷入对应 node。

> 取得 Apple Developer 证书后升级路径：`tauri.conf.json` 配 `signingIdentity` → `codesign` → `notarytool` 公证 → `staple`，届时移除本节降级说明。

---

## 常用脚本

**根目录（聚合）**

| 命令 | 作用 |
| --- | --- |
| `npm run dev:api` | 启动 API sidecar（watch 模式） |
| `npm run dev:web` | 启动 Web 前端（Vite） |
| `npm run build` | 构建 api + web |
| `npm run typecheck` | api + web 类型检查 |
| `npm run test` | 运行 api 测试（vitest） |
| `npm run prisma` | 数据库管理脚本（`scripts/db.mjs`） |
| `npm run desktop:check` / `desktop:test` / `desktop:dev` / `desktop:build` | Cargo 检查 / 测试 / 运行 / 构建 |

**`apps/api` 子脚本**：`build`(nest build)、`start`、`start:dev`、`typecheck`、`test`(vitest)、`prisma`、`db:deploy`（迁移部署）。

**`apps/web` 子脚本**：`dev`(vite)、`build`、`preview`、`typecheck`。

---

## 数据持久化

- 任务、产出物、设置、字段定义等数据统一由 `@atb/api` 通过 **Prisma 6 + SQLite** 管理，数据库文件保存在本机用户目录。
- 数据库模式与迁移入口为 `apps/api/scripts/db.mjs`（根脚本 `npm run prisma` 调用）。
- 产出物（artifacts）支持签名资源（`signed-resource.middleware.ts`）与 diff 比对，确保 Agent 写入内容经人工审核后可见。

---

## 文档

- `docs/Agent Task Board 产品与设计文档 v1.5.md` — 产品与技术方案
- `docs/Agent Task Board 高保真原型 v1.1.md` — 高保真交互原型

---

## 许可证

私有项目，未开放外部授权。
