# Agent Task Board

本地桌面任务看板：**人建任务，Agent 经 MCP / REST 认领执行，结果强制人工审核。**

整个应用以桌面客户端形态运行在用户本机：前端在 Tauri 主窗口内渲染，业务逻辑全部由本地托管的 Node sidecar 提供，数据保存在本地 SQLite 文件，不依赖任何远端服务。

- 主仓库：`agent-task-board`（npm workspaces monorepo，Node ≥ 20）
- 包名：`@atb/web`（前端）、`@atb/api`（后端 sidecar）、`@atb/desktop`（桌面壳）

> **只想干活？直接跳「快速上手速查」**——按你的目标选一条路径，复制命令即可。

---

## 快速上手速查

| 你的目标 | 走哪条路径 | 最少步骤 |
| --- | --- | --- |
| 开发调试（改代码、跑测试） | 路径 A：[开发模式](#路径-a开发模式) | `npm install` → `npm run prisma` → `npm run dev:api` + `npm run dev:web` |
| 本机跑一下桌面壳（不要安装包） | 路径 B：[构建裸二进制](#路径-b构建裸二进制本机运行) | `npm run build` → `npm run desktop:build` |
| **打包可分发的 .app / .dmg** | 路径 C：[打包安装包](#路径-c打包可分发的-app--dmg) | `npm install` → `npm run build` → `npm run build:sidecar -w @atb/api` → `npx tauri build` → `hdiutil` |
| 拿到 .dmg 后装不上 / 打不开 | 见 [运行须知（Gatekeeper）](#运行须知签名与-gatekeeper无证书降级方案) | 右键「打开」或 `xattr -cr` |

**路径 C 一屏版（macOS，从零到 .dmg 全过程）：**

```bash
npm install                                  # ① 依赖（仅首次）
npm run build                                # ② 构建 api + web
npm run build:sidecar -w @atb/api            # ③ 装配 sidecar 打包资源（~135M，不入库）
cd apps/desktop/src-tauri
export PATH="$HOME/.cargo/bin:$PATH"
npx tauri build                              # ④ 打包 .app（dmg 步骤失败属预期，见下）
cd target/release/bundle
hdiutil create -volname "Agent Task Board" \
  -srcfolder "macos/Agent Task Board.app" -ov -format UDZO \
  "dmg/Agent Task Board_0.1.0_x64.dmg"       # ⑤ hdiutil 生成 .dmg
```

> ⚠️ 换机器 / 换架构打包前，先把对应架构的 **node 二进制**放到
> `apps/desktop/src-tauri/resources/sidecar/node`（不入库，③ 会原样使用）。详见路径 C 第 0 步。

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
│   │   ├── scripts/  # db.mjs（数据库管理）、bundle-sidecar.mjs（打包装配）
│   │   └── src/
│   │       ├── tasks/        # 任务 CRUD、过滤、状态流转
│   │       ├── artifacts/    # 产出物存储、签名资源、diff
│   │       ├── auth/         # 作用域与鉴权守卫
│   │       ├── field-defs/   # 自定义字段定义
│   │       ├── settings-api/ # 设置接口
│   │       ├── contract/     # 共享契约（schema/enums/transitions/ids）
│   │       ├── infra/        # Prisma、事件、通知、审计、日志、bootstrap
│   │       └── main.ts
│   ├── web/          # @atb/web — React 主窗口前端
│   │   └── src/
│   │       ├── api/    app/    components/    features/
│   │       ├── lib/    styles/    ws/    main.tsx
│   └── desktop/       # @atb/desktop — Tauri 2 桌面壳（Rust）
│       └── src-tauri/
│           ├── src/          # main / window / tray / sidecar / commands / state / diag ...
│           ├── resources/    # sidecar 打包资源（不入库，打包脚本生成）
│           └── Cargo.toml
├── docs/            # 产品与设计文档、高保真原型、操作手册、发版记录
├── scripts/         # Cursor 外部调度脚本（cursor-agent-poll.mjs）
├── package.json     # 根 workspaces 与聚合脚本
└── README.MD
```

---

## 环境要求

- **Node.js ≥ 20**（根 `package.json` 的 `engines`）
- **npm**（使用 workspaces，无需 pnpm/yarn）
- **Rust 工具链**（仅路径 B / C 需要）：`cargo` 需在 `PATH` 中，构建前执行 `export PATH="$HOME/.cargo/bin:$PATH"`
- **`@tauri-apps/cli@2`**（仅路径 C 需要，已列为根 devDependency，随 `npm install` 自动安装）
- **额外一份 node 二进制**（仅路径 C 需要）：与目标架构一致（当前 release 为 x86_64），放在 `apps/desktop/src-tauri/resources/sidecar/node`；该文件不入库，见路径 C 第 0 步

---

## 路径 A：开发模式

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

> 开发模式与打包后的 .app 共用同一份数据目录（`~/.agent-board/`）。

---

## 路径 B：构建裸二进制（本机运行）

```bash
npm run build           # = nest build (api) && tsc -b && vite build (web)
npm run desktop:build   # cargo build --release → 裸二进制 atb-desktop
./apps/desktop/src-tauri/target/release/atb-desktop   # 运行
```

> 裸二进制**不自包含**：web UI 已编译期嵌入，但启动 sidecar 需要 `PATH` 里有 node，
> 或设置 `ATB_NODE_BIN` 指向 node 可执行文件。要自包含分发包，请走路径 C。

---

## 路径 C：打包可分发的 .app / .dmg

> **顺序不能乱**：api/web 先于桌面壳构建（`build.rs` 编译期注入 api 入口、Tauri 编译期嵌入 `web/dist`）；
> sidecar 资源必须在 `tauri build` 之前装配好。

### 第 0 步（前置）：放入 node 运行时

`.app` 内自带的 node 运行时**不入库**，每次换机器 / 换目标架构打包前需手动放入：

```bash
# 与目标架构一致（当前发布口径为 x86_64）：
mkdir -p apps/desktop/src-tauri/resources/sidecar
cp /path/to/node apps/desktop/src-tauri/resources/sidecar/node
file apps/desktop/src-tauri/resources/sidecar/node   # 确认 Mach-O x86_64
```

> 也可跳过手动拷贝，改用环境变量：`ATB_NODE_BIN=/path/to/node npm run build:sidecar -w @atb/api`。

### 第 1–3 步：构建 + 装配 sidecar 资源

```bash
npm install                              # 仅首次
npm run build                            # api（tsc）+ web（vite）
npm run build:sidecar -w @atb/api        # 装配打包资源
```

`build:sidecar`（`apps/api/scripts/bundle-sidecar.mjs`）产出
`apps/desktop/src-tauri/resources/sidecar/`（~135M，不入库），做四件事：

1. **webpack 单文件 bundle**：ts-loader 保留 `emitDecoratorMetadata`（esbuild 不支持该特性，会打挂 Nest 依赖注入）；仅 `@prisma/client` 外置，Nest 可选 peer 依赖以哑桩替换；
2. 装配**最小 Prisma 运行时**：生成客户端 + schema + query engine（整包 97M 裁到 ~21M）；
3. 装配 `prisma/migrations`（bootstrap 按 `__dirname` 定位迁移目录）；
4. 拷入 node 运行时（`ATB_NODE_BIN` 优先，缺省用当前执行的 node；**必须与目标架构一致**）。

> 真机验收教训：跳过此步只带 `dist/main.js`，双击启动必报 `Cannot find module '@nestjs/core'`。

### 第 4 步：打包 .app

```bash
cd apps/desktop/src-tauri
export PATH="$HOME/.cargo/bin:$PATH"
npx tauri build      # .app 产出在 target/release/bundle/macos/
```

### 第 5 步：生成 .dmg

`tauri build` 自带的 `bundle_dmg.sh` 依赖 `osascript` 摆 Finder 窗口，**在无头 / 沙箱会话下必失败（属预期，不影响 .app）**。用 `hdiutil` 兜底：

```bash
cd apps/desktop/src-tauri/target/release/bundle
hdiutil create -volname "Agent Task Board" \
  -srcfolder "macos/Agent Task Board.app" -ov -format UDZO \
  "dmg/Agent Task Board_0.1.0_x64.dmg"
```

**交付物**：`target/release/bundle/dmg/Agent Task Board_0.1.0_x64.dmg`（分发给他人只需这一个文件；或直接压缩 `.app`）。

---

## 运行须知（签名与 Gatekeeper，无证书降级方案）

**当前发布口径：未签名（本机无 Apple Developer 证书，阶段一按降级方案交付）。**

- **首次打开被 Gatekeeper 拦截**是预期行为，两种解除方式：
  1. 右键 `.app` →「打开」→ 再点「打开」（弹窗确认一次即可，之后正常启动）；
  2. 终端执行 `xattr -cr "/path/Agent Task Board.app"` 清除隔离属性后双击。
- `.dmg` 本身下载/拷贝不受影响，拦截发生在首次运行 `.app` 时。
- **x86_64 架构**：当前 release 二进制为 x86_64，在 Apple Silicon 上走 Rosetta（可用，但非性能最优）。

### arm64 原生构建（Apple Silicon 机器上执行）

```bash
# 1. 添加 arm64 Rust 目标
rustup target add aarch64-apple-darwin

# 2. 准备 arm64 版 node 二进制（不能用 x86_64 node！）
#    任一来源均可：nodejs.org arm64 pkg / Homebrew / 已有安装
mkdir -p apps/desktop/src-tauri/resources/sidecar
cp /path/to/arm64-node apps/desktop/src-tauri/resources/sidecar/node

# 3. 指定目标架构构建
cd apps/desktop/src-tauri
export PATH="$HOME/.cargo/bin:$PATH"
npx tauri build --target aarch64-apple-darwin
# 产物在 target/aarch64-apple-darwin/release/bundle/macos/
```

### Universal 通用包（双架构单包）

`npx tauri build --target universal-apple-darwin`。
注意：node 侧也要是 universal 二进制（`lipo -create x86_64-node arm64-node -output node` 合成），
否则 Rosetta 缺失的环境（如全新 arm64 机器未装 Rosetta）里 sidecar 起不来。

> 取得 Apple Developer 证书后的升级路径：`tauri.conf.json` 配 `signingIdentity` → `codesign` → `notarytool` 公证 → `staple`，届时移除本节降级说明。

---

## 附录：`target/release/` 产物说明

> 本节产物均产生自 macOS 构建；跨平台产物（Windows NSIS / Linux deb、AppImage）为阶段二项，届时在同一 `bundle/` 下按平台分子目录。

| 路径 | 大小 | 适用系统 | 性质 | 说明 |
| --- | --- | --- | --- | --- |
| `atb-desktop` | 5.2M | **macOS**（Mach-O x86_64；Apple Silicon 经 Rosetta） | **可执行产物** | 路径 B 的裸二进制；web UI 已编译期嵌入（`frontendDist`），api 入口已由 `build.rs` 注入。**不自包含**：启动 sidecar 需 `PATH` 里有 node 或设 `ATB_NODE_BIN` |
| `atb-desktop.d` | <1K | 与构建平台无关 | 构建元数据 | cargo 生成的 depfile，可忽略 |
| `sidecar/` | ≈135M | **macOS**（node 为 x86_64 Mach-O） | 打包中间资源 | `npm run build:sidecar` 的装配产物：`main.js`（单文件 bundle）+ `node` + `prisma/migrations` + 最小 `node_modules`；删了重新跑脚本即可 |
| `build/` `deps/` `incremental/` `examples/` | — | 与构建平台一致 | cargo 中间产物 | 编译缓存与依赖产物，只影响增量编译速度，可随时删（删后全量重编） |
| `bundle/macos/Agent Task Board.app` | 142M | **macOS**（10.15+，x86_64 / Apple Silicon） | **交付产物** | 自包含 .app：`Contents/MacOS/atb-desktop` + `Resources/sidecar/{main.js, node, prisma/migrations, node_modules}` + 图标，Finder 双击可独立运行 |
| `bundle/dmg/Agent Task Board_0.1.0_x64.dmg` | 56M | **macOS**（仅 macOS 可挂载） | **交付产物** | 最终分发镜像（UDZO），校验和见 `docs/发版记录 v0.1.0.md` |
| `bundle/dmg/bundle_dmg.sh` `bundle/dmg/icon.icns` | — | macOS（依赖 osascript） | 工具残留 | tauri 的 DMG 打包脚本及资源；无头会话下 osascript 必失败，实际 .dmg 用 `hdiutil` 兜底生成 |
| `bundle/macos/rw.*.dmg` | — | macOS | 失败残留 | `bundle_dmg.sh` 中断留下的读写临时镜像，**可安全删除** |
| `bundle/share/create-dmg/` | — | 与构建平台无关 | 工具残留 | create-dmg 脚本临时目录，**可安全删除** |

> 清理：`cargo clean` 会连同交付产物一起删除，重新打包即可恢复；只清缓存可单独删 `build/ deps/ incremental/`。

---

## 常用脚本

**根目录（聚合）**

| 命令 | 作用 | 属于 |
| --- | --- | --- |
| `npm run dev:api` | 启动 API sidecar（watch 模式） | 路径 A |
| `npm run dev:web` | 启动 Web 前端（Vite） | 路径 A |
| `npm run prisma` | 数据库管理脚本（`apps/api/scripts/db.mjs`） | 路径 A |
| `npm run build` | 构建 api + web | A / B / C 通用 |
| `npm run build:sidecar -w @atb/api` | 装配 sidecar 打包资源 | 路径 C |
| `npm run desktop:build` | cargo 构建裸二进制 | 路径 B |
| `npm run desktop:check` / `desktop:test` / `desktop:dev` | Cargo 检查 / 测试 / 运行 | 开发辅助 |
| `npm run typecheck` | api + web 类型检查 | 质量门禁 |
| `npm run test` | 运行测试（vitest） | 质量门禁 |

**`apps/api` 子脚本**：`build`（nest build）、`start`、`start:dev`、`typecheck`、`test`（vitest）、`prisma`、`db:deploy`（迁移部署）、`build:sidecar`（打包装配）。

**`apps/web` 子脚本**：`dev`（vite）、`build`、`preview`、`typecheck`。

---

## 数据持久化

- 任务、产出物、设置、字段定义等数据统一由 `@atb/api` 通过 **Prisma 6 + SQLite** 管理，数据库文件保存在本机用户目录（`~/.agent-board/`）。
- 数据库模式与迁移入口为 `apps/api/scripts/db.mjs`（根脚本 `npm run prisma` 调用）。
- 打包 .app 与开发模式共用同一数据目录；既有库（开发期建的）首次被打包 app 打开时会自动对齐迁移水位。
- 产出物（artifacts）支持签名资源（`signed-resource.middleware.ts`）与 diff 比对，确保 Agent 写入内容经人工审核后可见。

---

## 文档

- `docs/Agent Task Board 产品与设计文档 v1.5.md` — 产品与技术方案
- `docs/Agent Task Board 高保真原型 v1.1.md` — 高保真交互原型
- `docs/系统操作使用手册.md` — 安装、配置与运维
- `docs/任务创建模版（Agent 协助）.md` — 发给 AI 助手即可按约束代建任务
- `docs/发版记录 v0.1.0.md` — 产物清单、SHA-256、已知限制
- `docs/开发计划-阶段一收尾与阶段二.md` — 当前状态快照与任务规划

---

## 许可证

私有项目，未开放外部授权。
