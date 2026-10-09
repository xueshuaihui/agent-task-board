# Jarvis Workbench

本地桌面任务看板：**人建任务，Agent 经 MCP / REST 认领执行，默认强制人工审核、任务级显式豁免。**

整个应用以桌面客户端形态运行在用户本机：前端在 Tauri 主窗口内渲染，业务逻辑全部由本地托管的 Node sidecar 提供，数据保存在本地 SQLite 文件，不依赖任何远端服务。

- 主仓库：`agent-task-board`（npm workspaces monorepo，Node ≥ 20）
- 包名：`@atb/web`（前端）、`@atb/api`（后端 sidecar）、`@atb/desktop`（桌面壳）

> **只想干活？直接跳「快速上手速查」**——按你的目标选一条路径，复制命令即可。

---

## 快速上手速查

| 你的目标 | 走哪条路径 | 最少步骤 |
| --- | --- | --- |
| **使用这个产品**（不是开发） | 见下方 [产品使用概览](#产品使用概览) | 安装 .dmg（macOS）/ .exe（Windows）→ 双击启动 → 看板建任务 |
| 开发调试（改代码、跑测试） | 路径 A：[开发模式](#路径-a开发模式) | `npm install` → `npm run prisma` → `npm run dev:api` + `npm run dev:web` |
| 本机跑一下桌面壳（不要安装包） | 路径 B：[构建裸二进制](#路径-b构建裸二进制本机运行) | `npm run build` → `npm run desktop:build` |
| **打包可分发的 .app / .dmg（一键，macOS）** | `npm run package:release` | 放好 node 二进制 → 一条命令到底（门禁/构建/装配/打包/冒烟/校验和全自动） |
| **打包可分发的 .exe（一键，Windows x64）** | `bash scripts/package-release-win.sh`（Git Bash） | 同一条链：门禁 → 构建 → 装配 → 引擎硬校验 → NSIS → 冒烟 → 校验和 |
| 打包想逐步手动执行 | 路径 C：[打包安装包](#路径-c打包可分发的-app--dmg) | `npm install` → `npm run build` → `npm run build:sidecar -w @atb/api` → `npx tauri build` → `hdiutil` |
| **把新版本发到 GitHub Releases** | [发布到 GitHub Releases 速查](#发布到-github-releases-速查) | commit → `git push origin vX.Y.Z`（CI 自动构建发布）；兜底见方式二 |
| 拿到 .dmg 后装不上 / 打不开（macOS） | 见 [运行须知](#运行须知签名与-gatekeeper--smartscreen无证书降级方案) | 右键「打开」或 `xattr -cr` |
| 拿到 .exe 被 SmartScreen 拦（Windows） | 同章节的 [SmartScreen 小节](#smartscreen-windows-首启不签名是既定决策) | 「更多信息」→「仍要运行」（每次重装都会再弹） |

**一键打包（推荐，= 路径 C 全流程自动化 + 冒烟 + 校验和）：**

```bash
# 前置（macOS，仅换机器/换架构时）：把目标架构的 node 二进制放到
# apps/desktop/src-tauri/resources/sidecar/node（不入库；CI 全新 checkout 由脚本第 0 步自动装配）
npm run package:release            # 门禁 → 构建 → 装配 sidecar → .app → .dmg → 冒烟 → SHA-256

# Windows x64：Git Bash 下执行（CI 的 win-x64 job 跑的就是这条命令）
bash scripts/package-release-win.sh  # 门禁 → 构建 → 装配 sidecar → node.exe/引擎硬校验 → NSIS .exe → 冒烟 → SHA-256
```

> 版本号自动读自 `apps/desktop/src-tauri/tauri.conf.json`；mac 版可选参数 `--skip-gates` / `--skip-dmg` / `--skip-smoke`，
> Windows 版只有 `--skip-gates` / `--skip-smoke`（无 dmg 环节）。
> ⚠️ Windows 包没有签名/公证环节，**产物冒烟是「装进包里的内容真能跑」的唯一闸口**，正式 release 不要 `--skip-smoke`。

**路径 C 手动版（macOS，从零到 .dmg 全过程；想理解每步在做什么再看）：**

```bash
npm install                                  # ① 依赖（仅首次）
npm run build                                # ② 构建 api + web
npm run build:sidecar -w @atb/api            # ③ 装配 sidecar 打包资源（~135M，不入库）
cd apps/desktop/src-tauri
export PATH="$HOME/.cargo/bin:$PATH"
npx tauri build                              # ④ 打包 .app（dmg 步骤失败属预期，见下）
cd target/release/bundle
hdiutil create -volname "Jarvis Workbench" \
  -srcfolder "macos/Jarvis Workbench.app" -ov -format UDZO \
  "dmg/Jarvis Workbench_0.1.0_x64.dmg"       # ⑤ hdiutil 生成 .dmg
```

> ⚠️ 换机器 / 换架构打包前，先把对应架构的 **node 二进制**放到
> `apps/desktop/src-tauri/resources/sidecar/node`（不入库，③ 会原样使用）。详见路径 C 第 0 步。

---

## 产品使用概览

> 完整操作说明见 `docs/系统操作使用手册.md`（第 3–5 章）；本节只给最短理解路径。

### 一句话工作流

**你在看板上建任务 → Agent 经 MCP / REST 认领并执行 → 结果进入「待审核」→ 你审核通过才生效。**
默认由你把关；建单时可对单个任务显式选「免审核」（执行完直接完成）——
豁免是建单那一刻由你做的决定，且全程留痕（评论与审计各记一笔）。
「等 Agent 审」（由非执行者的审核者 Token 领队列回结论）这一选项**按 `docs/v0.0.4/beta真机验证清单.md` §14 裁定【1009 移除中】**（S1/S2 落地、S4 收口复验；当前 v0.0.4-beta.9 安装包内该链仍在，见清单 §13 待包⑤），人工审核与免审核直通两条路保留、行为不变。
所有产出物（diff / 文件 / 链接）经审核后可见、可退回。

### 界面速览（桌面端主窗口）

| 页面 | 干什么 |
| --- | --- |
| **看板** | 六列任务流：需求池 → 待执行 → 执行中 → 待审核 → 已完成 / 异常；拖拽流转 |
| **审核** | 待审核队列，逐条批（通过 / 驳回 + 意见），可自动跳下一条 |
| **任务** | 列表视图：筛选、搜索、排序、分页 |
| **设置** | Token 管理、字段定义、模板、数据导入导出、备份、审计日志 |
| 🔔 铃铛 | 未读通知角标（审核待办、执行失败、租约过期…），点击直达 REVIEW 过滤 |

### 建任务的三种方式

1. **看板 UI**：拖拽 / 表单直接建；
2. **让 AI 助手代建（推荐）**：把 `docs/任务创建模版（Agent 协助）.md` 发给任意 AI 助手，按字段约束填 JSON 后代调创建；
3. **REST**：`POST /api/v1/tasks`（UI Token 鉴权，见模版文档第 4 节）。

> 新任务一律进「需求池」；要被执行 Agent 精确认领，可在任务上标注能力要求（如 `repo:agent-task-board`）。

### Agent 接入（让执行方干活）

1. **设置 → Token** 签发 Agent Token（与 UI Token 分组，互不可调用对方接口）；
2. Agent 走 **MCP**（`http://127.0.0.1:7788/mcp`）或 **REST** 九个工具：
   `list_ready_tasks` → `claim_next_task`（建租约）→ `update_progress` / `append_log` → `complete_task`；
3. Cursor 用户可直接用现成调度脚本 `scripts/cursor-agent-poll.mjs`（轮询认领，免写接入代码）。

### 数据在哪

全部本地：SQLite（macOS `~/.jarvis-workbench/`、Windows `%APPDATA%\jarvis-workbench\`，v0.0.4 W1b 起；旧名 `.agent-board` / `agent-board`）+ 产物文件，仅监听 `127.0.0.1`，无远端依赖；备份 / 导入导出在「设置」内操作。

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
- Agent 通过 MCP 与 REST 两种通道接入，任务产出物默认经人工审核后才生效（任务级 `review_mode` 可显式豁免，执行者永远改不了自己任务的审核方式）。

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
├── scripts/         # 辅助脚本：cursor-agent-poll.mjs（外部调度）、package-release.sh（mac 一键打包）、package-release-win.sh（Windows x64 一键打包，Git Bash）、release.sh（SOP 七阶段全流程，CI 化后仅兜底）
├── package.json     # 根 workspaces 与聚合脚本
└── README.MD
```

---

## 环境要求

- **Node.js ≥ 20**（根 `package.json` 的 `engines`）
- **npm**（使用 workspaces，无需 pnpm/yarn）
- **Rust 工具链**（仅路径 B / C 需要）：`cargo` 需在 `PATH` 中，构建前执行 `export PATH="$HOME/.cargo/bin:$PATH"`
- **`@tauri-apps/cli@2`**（仅路径 C 需要，已列为根 devDependency，随 `npm install` 自动安装）
- **额外一份 node 二进制**（仅 macOS 路径 C 本机跨架构打包需要）：与目标架构一致（当前 release 为 x86_64），放在 `apps/desktop/src-tauri/resources/sidecar/node`；该文件不入库，CI 全新 checkout 由脚本自动用当前 node 装配，见路径 C 第 0 步
- **Windows 侧**（打 Windows 包 / 跑 Windows 包）：
  - 打包需 **Git Bash**（脚本用到 `uname -m` / `cygpath` / `sha256sum` / `curl.exe`）+ Rust 工具链 + Node ≥ 20（CI 的 `setup-node` 用 22）；`node.exe` 与 Prisma Windows 引擎均取自构建机，**不需要手动放二进制**；
  - **仅 x64**：不出 win-arm64 是既定决策（脚本第 0 步对非 `x86_64` 构建机直接停）；
  - 运行需 **Windows 10 及以上** + **WebView2**：`tauri.conf.json` 的 `webviewInstallMode.type = "downloadBootstrapper"`，安装包不带运行时，**装的时候需要联网**拉 Evergreen 版（Win11 / 打过更新的 Win10 一般已自带，Windows N / LTSC 必须联网）。

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

> 开发模式与打包后的安装包共用同一份数据目录（macOS `~/.jarvis-workbench/`、Windows `%APPDATA%\jarvis-workbench\`，v0.0.4 W1b 起）。

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

`.app` 内自带的 node 运行时**不入库**：本机换机器 / 换目标架构打包前需手动放入（CI 全新 checkout 时脚本第 0 步会用构建机当前 node 自动装配，Windows 侧同理由 `node.exe` 承担）：

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
hdiutil create -volname "Jarvis Workbench" \
  -srcfolder "macos/Jarvis Workbench.app" -ov -format UDZO \
  "dmg/Jarvis Workbench_0.1.0_x64.dmg"
```

**交付物**：`target/release/bundle/dmg/Jarvis Workbench_<版本>_<架构>.dmg`——dmg 后缀按**构建机架构自动判定**（Intel 机出 `_x64`，Apple Silicon 出 `_arm64`；脚本第 0 步会校验 sidecar node 架构一致性）。mac 用户按自己架构取对应那一个文件即可；或直接压缩 `.app`。CI 发布时 mac 双架构 dmg + Windows x64 `setup.exe` 三份一起出齐（见下节方式一与「Windows 安装包」一节）。

---

## Windows 安装包：NSIS .exe（路径 C 的 Windows 对应版）

> SmartScreen 引导话术、per-user 安装位置、WebView2 离线方案等口径细节见 `docs/发布手册.md` §1.3，此处不重述。

`scripts/package-release-win.sh` 是 `scripts/package-release.sh` 的 Windows 对应版，**步骤编号与 mac 版对齐**：
mac 的 4.2 / 4.5 / 5（plist 校验、`codesign`、`hdiutil` 出 dmg）在 Windows 没有对应物——**整体不存在，不是被跳过**
（所以脚本从第 4 步直接跳到第 6 步）。脚本在 **Git Bash** 下运行，CI 的 win-x64 job 调的就是它。

| 步 | 做什么 | Windows 侧要点 |
| --- | --- | --- |
| 0 | 前置检查 | `uname -m` 必须是 `x86_64`（非 x64 构建机当场停）；`node.exe` 不在则先用当前 node 占位装配 |
| 1 | 质量门禁 | `npm run typecheck` + `npm run test`，硬门禁不降级；用例里的 POSIX 假设会拖红**整条** Windows 发布 |
| 2 | 构建 api + web | 同 mac |
| 3 | 装配 sidecar + 产物硬校验 | 装完必须查到 `resources/sidecar/node.exe` 与 `node_modules/.prisma/client/query_engine-windows*.dll.node`，缺一即停（防「静默装了别平台引擎」） |
| 4 | `npx tauri build`（NSIS） | 退出码非 0 多来自签名/收尾噪音（本项目刻意不签名），**以产物文件在不在为准** |
| 6 | 产物冒烟 | 直跑 sidecar 的 `node.exe main.js`：等 `ATB_READY`、`GET /api/v1/tasks` 需返回 401；Windows 无签名/公证门禁，**这一步是包内容真能跑的唯一闸口** |
| 7 | `sha256sum` | 写 `bundle/SHA256SUMS.txt`（与 mac 的 `shasum` 同算法同行格式） |

```bash
bash scripts/package-release-win.sh              # 全流程（门禁 → 构建 → 装配 → 硬校验 → NSIS → 冒烟 → 校验和）
bash scripts/package-release-win.sh --skip-smoke # 仅排障用；正式 release 禁止（见第 6 步说明）
```

**交付物**：`apps/desktop/src-tauri/target/release/bundle/nsis/Jarvis Workbench_<版本>_x64-setup.exe`
（版本号取 `tauri.conf.json` 的 `version`）；上传 GitHub 后空格换成点号。
**仅 x64**——不出 win-arm64 是既定决策，不是漏项。

**当前状态**：流水线已接通（tag 与 mac 同一次触发），**首个绿的 Windows 构建尚未产出**，
产物大小与校验和以首次 CI 实测为准，在此之前不对外承诺可下载。

**数据与日志落在两个不同目录**（`apps/api/src/common/paths.ts`，与主进程 `apps/desktop/src-tauri/src/paths.rs` 同源）：
数据 `%APPDATA%\jarvis-workbench\jarvis.db`（`ATB_DATA_DIR` 可覆盖），
日志 `%APPDATA%\AgentTaskBoard\logs`（`ATB_LOGS_DIR` 可覆盖）——卸载 / 清档 / 取证按**两个**目录处理。

---

## 发布到 GitHub Releases 速查

> 完整 SOP（含前置安装、坑实录、逐项检查清单）见 `docs/发布手册.md`；本节是最少命令版。

### 方式一（推荐）：推 tag 自动发布，无需本地打包、无需 token

`.github/workflows/release.yml` 已配置：tag 推送即触发 **GitHub Actions 云端构建**（门禁 → sidecar 装配 → 安装包 → 冒烟 → SHA256），并自动创建 Release、上传 mac 两个 `dmg` + Windows `setup.exe` + `SHA256SUMS.txt`。鉴权用仓库自带 `GITHUB_TOKEN`，**不涉及任何个人 token**。

```bash
git push origin main
git tag -a vX.Y.Z -m "vX.Y.Z <通道>：<一句话定位>"
git push origin vX.Y.Z        # ← 到此为止，构建与发布全自动
```

- 进度：仓库 **Actions** 页实时可看（三个 job 并行；mac 约 15–25 分钟，Windows job 是几百个 crate 的冷编译，超时上限给到 120 分钟）
- **三平台矩阵产物**：`macos-15-intel` 出 `*_x64.dmg`、`macos-15` 出 `*_arm64.dmg`、`windows-latest` 出 `*_x64-setup.exe`（macOS 双架构 + Windows x64，共三份）；分别以 `pkg-x64` / `pkg-arm64` / `pkg-win-x64` 上传，release job 汇总后 `sha256sum -- *.dmg *.exe` 合成一份 `SHA256SUMS.txt`（sidecar 的 node 与 Prisma 引擎按 runner 平台/架构原生生成，不跨平台装配、不依赖 Rosetta）
- **三平台全绿才发**：release job `needs: build`，任一平台构建失败就**不创建 Release**（矩阵 `fail-fast: false`，只为一次看全所有报错）
- **试运行通道**（Windows job 首跑/排障）：Actions 页手动 Run workflow（`workflow_dispatch`）照常构建三平台，产物发成 **draft** Release、tag 名 `dryrun-<sha7>`（刻意不以 `v` 开头，避免再命中 tag 触发）；验证完 `gh release delete dryrun-<sha7> --cleanup-tag`
- 通道约定自动生效：`v0.x.*` 一律 prerelease；`v1.0.0+` 自动为正式版
- tag 已存在 Release 时重推 = 补传产物（`--clobber` 覆盖同名资产）

### 方式二：本地打包 + 手动上传（CI 不可用时的兜底）

一键打包（含门禁与冒烟）先行：`npm run package:release`，然后：

#### ① 提交并打 tag（annotated）

```bash
git add <本次发布包含的变更>
git commit -m "..."
git push origin main
git tag -a vX.Y.Z -m "vX.Y.Z <通道>：<一句话定位>

- 主要变更点
- 已知限制"
git push origin vX.Y.Z
```

> 通道约定：里程碑间的对外分发用 prerelease（如 v0.0.2）；验收门禁全过后走正式版。tag 是发布批次标识，包内版本跟随 `tauri.conf.json` 的 `version`。

#### ② 创建 Release 并上传产物

```bash
export GH_TOKEN=<你的 fine-grained token>        # 用完即撤销，见下⚠️
~/.local/bin/gh release create vX.Y.Z \
  --title "vX.Y.Z <通道>：<一句话定位>" \
  --notes-file /tmp/release-notes-vX.Y.Z.md \    # 先写好：安装指引 + 变更清单 + 已知限制
  --prerelease                                   # 正式版去掉此参数

~/.local/bin/gh release upload vX.Y.Z \
  "apps/desktop/src-tauri/target/release/bundle/dmg/Jarvis Workbench_<版本>_x64.dmg" \
  apps/desktop/src-tauri/target/release/bundle/SHA256SUMS.txt --clobber
```

### ③ 核验

```bash
~/.local/bin/gh release view vX.Y.Z --json name,tagName,isPrerelease,assets \
  --jq '.name + " | " + (.isPrerelease|tostring) + " | assets: " + ([.assets[].name]|join(", "))'
```

> ⚠️ **token 三条铁律**（发布手册 §5.1 实录）：Fine-grained token 必须显式授权本仓库（否则 API 一律 404）；Permissions 需 Contents: Read and write；**发布完立即 revoke/regenerate**——token 一旦进过对话/终端历史就视为泄露。

---

## 运行须知（签名与 Gatekeeper / SmartScreen，无证书降级方案）

**macOS 口径：ad-hoc 签名（本机无 Apple Developer 证书，阶段一按无证书降级方案交付）；Windows 口径：完全不签名（无证书，是既定决策不是遗漏）。**
mac 产物由 `scripts/package-release.sh` 在 .app 产出后执行 `codesign --force --deep --sign -` ad-hoc 签名并过验签门禁：
Apple Silicon 上不再判「已损坏，无法打开」；但仍未做付费证书公证，首次打开会拦「无法验证开发者」，二选一解除：

- **首次打开被 Gatekeeper 拦截**是预期行为，两种解除方式：
  1. 右键 `.app` →「打开」→ 再点「打开」（弹窗确认一次即可，之后正常启动）；
  2. 终端执行 `xattr -cr "/path/Jarvis Workbench.app"` 清除隔离属性后双击。
- `.dmg` 本身下载/拷贝不受影响，拦截发生在首次运行 `.app` 时。
- **x86_64 架构**：当前 release 二进制为 x86_64，在 Apple Silicon 上走 Rosetta（可用，但非性能最优）。

### SmartScreen（Windows 首启，不签名是既定决策）

Windows 包**没有任何签名**（不套用 mac 的 ad-hoc 经验）：双击 `…_x64-setup.exe` 会弹蓝框「Windows 已保护你的电脑 / 未知发布者」，
点「**更多信息**」→「**仍要运行**」；**重装 / 换机每次都会再弹一次**。对外话术不建议关 Defender 或 SmartScreen，
细节（WebView2 联网前置、per-user 安装位置、安装器语言）统一见 `docs/发布手册.md` §1.3，此处不重述。

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
此外 **Prisma query engine 也是按架构生成的原生库**，universal 包内需同时带两套引擎并按运行架构选择，
`bundle-sidecar.mjs` 目前不支持——因此**本项目采用「每平台每架构独立包」**（CI matrix 三 runner 各出一份：
mac `_x64.dmg` / `_arm64.dmg` + Windows `x64-setup.exe`，
见 [发布到 GitHub Releases 速查](#发布到-github-releases-速查) 方式一），规避 universal 的额外复杂度。

> 取得 Apple Developer 证书后的升级路径：`tauri.conf.json` 配 `signingIdentity` → `codesign` → `notarytool` 公证 → `staple`，届时移除本节降级说明。

---

## 附录：`target/release/` 产物说明

> 本节 macOS 行产生自 mac 构建；Windows 产物在同一 `bundle/` 下的 `nsis/` 子目录（见下表 *Windows* 行，由 `scripts/package-release-win.sh` 在 `windows-latest` 上产出）；Linux（deb / AppImage）仍为阶段二项。

| 路径 | 大小 | 适用系统 | 性质 | 说明 |
| --- | --- | --- | --- | --- |
| `atb-desktop` | 5.2M | **macOS**（Mach-O x86_64；Apple Silicon 经 Rosetta） | **可执行产物** | 路径 B 的裸二进制；web UI 已编译期嵌入（`frontendDist`），api 入口已由 `build.rs` 注入。**不自包含**：启动 sidecar 需 `PATH` 里有 node 或设 `ATB_NODE_BIN` |
| `atb-desktop.d` | <1K | 与构建平台无关 | 构建元数据 | cargo 生成的 depfile，可忽略 |
| `sidecar/` | ≈135M | 与构建机一致（mac：`node`，Intel x86_64 / Apple Silicon arm64；Windows：`node.exe` + `query_engine-windows*.dll.node`） | 打包中间资源 | `npm run build:sidecar` 的装配产物：`main.js`（单文件 bundle）+ `node` + `prisma/migrations` + 最小 `node_modules`；删了重新跑脚本即可 |
| `build/` `deps/` `incremental/` `examples/` | — | 与构建平台一致 | cargo 中间产物 | 编译缓存与依赖产物，只影响增量编译速度，可随时删（删后全量重编） |
| `bundle/macos/Jarvis Workbench.app` | 142M | **macOS**（10.15+，x86_64 / Apple Silicon） | **交付产物** | 自包含 .app：`Contents/MacOS/atb-desktop` + `Resources/sidecar/{main.js, node, prisma/migrations, node_modules}` + 图标，Finder 双击可独立运行 |
| `bundle/dmg/Jarvis Workbench_<版本>_<架构>.dmg` | ≈56M | **macOS**（仅 macOS 可挂载） | **交付产物** | 最终分发镜像（UDZO）；`<架构>` 由构建机决定（`x64`/`arm64`），CI 发布时双架构各一份，校验和见 Release 内 `SHA256SUMS.txt` |
| `bundle/nsis/Jarvis Workbench_<版本>_x64-setup.exe` | 待首次 CI 实测回填 | **Windows** 10+（仅 x64；win-arm64 刻意不做） | **交付产物** | `scripts/package-release-win.sh` 经 `npx tauri build` 产出的 NSIS 安装包（per-user、不签名，首启口径见 `docs/发布手册.md` §1.3）；只在 Windows 构建机上产出，大小与校验和以首个绿 run 为准 |
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
| `npm run package:release` | **一键打包**：门禁→构建→装配→.app→.dmg→冒烟→SHA-256（dmg 架构后缀自动判定） | 路径 C |
| `npm run package:release -- --skip-gates` | 同上，跳过 typecheck/test | 赶时间自担风险 |
| `bash scripts/package-release-win.sh` | **Windows x64 一键打包**：门禁→构建→装配→node.exe/引擎硬校验→NSIS .exe→冒烟→SHA-256（Git Bash 下运行，CI win-x64 job 跑的同一条） | Windows 安装包 |
| `bash scripts/release.sh <tag>` | **SOP 七阶段全流程**（打包 + 提交/打 tag/推送 + gh 建 Release），CI 化后仅作 CI 不可用时的兜底 | 方式二 |
| `git push origin vX.Y.Z` | **CI 自动发布**（推荐）：云端构建三平台（mac `_x64`/`_arm64` dmg + Windows x64 `setup.exe`）→ 全绿才自动建 Release 上传产物 | 方式一 |
| `npm run desktop:check` / `desktop:test` / `desktop:dev` | Cargo 检查 / 测试 / 运行 | 开发辅助 |
| `npm run typecheck` | api + web 类型检查 | 质量门禁 |
| `npm run test` | 运行测试（vitest） | 质量门禁 |

**`apps/api` 子脚本**：`build`（nest build）、`start`、`start:dev`、`typecheck`、`test`（vitest）、`prisma`、`db:deploy`（迁移部署）、`build:sidecar`（打包装配）。

**`apps/web` 子脚本**：`dev`（vite）、`build`、`preview`、`typecheck`。

---

## 数据持久化

- 任务、产出物、设置、字段定义等数据统一由 `@atb/api` 通过 **Prisma 6 + SQLite** 管理，数据库文件保存在本机用户目录（macOS `~/.jarvis-workbench/jarvis.db`、Windows `%APPDATA%\jarvis-workbench\jarvis.db`，v0.0.4 W1b 起；旧名 `.agent-board` / `agent-board` 在升级首启一次性搬迁）。
- 日志目录**独立于数据目录**且名字不同：macOS `~/Library/Logs/AgentTaskBoard`、Windows `%APPDATA%\AgentTaskBoard\logs`（`ATB_LOGS_DIR` 可覆盖）——清档/取证要按两个目录处理，见 `apps/api/src/common/paths.ts`。
- 数据库模式与迁移入口为 `apps/api/scripts/db.mjs`（根脚本 `npm run prisma` 调用）。
- 打包 .app 与开发模式共用同一数据目录；既有库（开发期建的）首次被打包 app 打开时会自动对齐迁移水位。
- 产出物（artifacts）支持签名资源（`signed-resource.middleware.ts`）与 diff 比对，确保 Agent 写入内容经人工审核后可见。

---

## 文档

- `docs/Jarvis Workbench 产品与设计文档 v1.5.md` — 产品与技术方案
- `docs/Jarvis Workbench 高保真原型 v1.1.md` — 高保真交互原型
- `docs/系统操作使用手册.md` — 安装、配置与运维
- `docs/发布手册.md` — Release SOP：推 tag → CI 三平台出包（mac 双架构 dmg + Windows x64 `setup.exe`）并发布 Release（本地打包为附录；Windows 口径集中在 §1.3）
- `docs/任务创建模版（Agent 协助）.md` — 发给 AI 助手即可按约束代建任务
- `docs/发版记录 v0.0.1.md` / `docs/发版记录 v0.0.3.md` — 各发布批次的产物清单、SHA-256、已知限制（尚未发布过正式版）
- `docs/开发计划-阶段一收尾与阶段二.md` — 当前状态快照与任务规划

---

## 许可证

私有项目，未开放外部授权。
