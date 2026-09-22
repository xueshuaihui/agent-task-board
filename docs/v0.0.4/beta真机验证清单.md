# v0.0.4-beta.4 真机验证清单（#14 销账）

对象 Release：<https://github.com/xueshuaihui/agent-task-board/releases/tag/v0.0.4-beta.4>（prerelease，tag → `23a66b8`：#46 贾维斯唤醒词 MCP 工作模式 + 手册同步；含 beta.3 全量修复链：cf8f4f9 弹窗基座 WKWebView、60d34c3 抽屉 Tabs、44092fd flaky、#41 千问迁移 93 条内置技能。注：CI「创建 Release」job 因 GitHub Actions 账单问题未运行，Release 由本地下载 run 35752816415 双架构产物手动汇集，构建/门禁仍全部在 CI 完成）
本清单覆盖矩阵「#14 销账清单」四项：条款 1、4、68 首启、§20.3-8；另加 §5 beta.4 唤醒词功能项。前四项全过即 #14 关单、宣布进入预发布。

## 0. 下载与完整性（前置）

- [ ] 按本机架构下载对应 dmg：Apple Silicon → `Jarvis.Workbench_0.1.0_arm64.dmg`（57.7MB）；Intel → `Jarvis.Workbench_0.1.0_x64.dmg`（59.8MB）
- [ ] 校验 SHA-256 与 Release 内 `SHA256SUMS.txt` 一致（注意 SUMS 内以空格名登记，比对以哈希为准）：
  - arm64：`2a392f9d7ad06b1ff00be3c313360dbc2ef2a3101ed3de47a42336dda9809c41`
  - x64：`215999d680e9c93e83f41fdd5e294ffdb9bff384e6789f7d74bb9416cc82b791`
  - 命令：`shasum -a 256 "Jarvis.Workbench_0.1.0_<arch>.dmg"`
- [ ] （建议，非门禁）挂载 dmg 前对旧库手动再拷一份保险副本：`cp ~/.agent-board/atb.db /tmp/atb.db.insure-$(date +%F)`

## 1. 条款 1 · 双击启动 + 托盘图标

- [ ] 挂载 dmg，把 Jarvis Workbench.app 拖入「应用程序」
- [ ] 双击 .app 启动：主窗口正常出现，看板页可交互（首次启动看 §3 迁移现象）
- [ ] 菜单栏（顶部托盘区）出现托盘图标
- [ ] 无 Gatekeeper 拦截无法运行的情况（如被拦：右键 → 打开；记录现象回填）

## 2. 条款 4 · 关窗常驻 + 托盘交互

- [ ] 点窗口关闭按钮：窗口消失但进程常驻（`pgrep -f "Jarvis Workbench"` 仍在；sidecar 端口 `curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:7788/api/v1/tasks` 返回 401 而非拒连）
- [ ] 托盘菜单「打开/恢复」：窗口恢复可见可操作
- [ ] 托盘菜单「退出」：进程真正退出（app 与 sidecar 都消失，端口拒连）

## 3. 条款 68 · 真库首启自动迁移（一次性，重点项）

场景：本机真实旧库 `~/.agent-board/atb.db`（schema 停 0006、`_prisma_migrations` 账本残缺）→ 首启应自动搬到 `~/.jarvis-workbench/jarvis.db` 并补迁到 0014。

- [ ] 首次启动触发搬迁：`~/.jarvis-workbench/` 生成 `jarvis.db`；旧目录保留原位且有 `backups/` 备份与迁移指引文件（`ls ~/.jarvis-workbench ~/.agent-board`）
- [ ] 迁移水位到 0014：`sqlite3 ~/.jarvis-workbench/jarvis.db "select count(*) from _prisma_migrations where finished_at is not null"` ≥ 14，且 0007–0014 迁移对应新表/列存在（如 notification/creation_request 相关表）
- [ ] 数据完整保留：旧库里的任务/分组/技能在 UI 中可见、条数对得上（`select count(*) from Task;` 对比旧库副本 `/tmp/atb.db.insure-*`）
- [ ] `PRAGMA foreign_key_check` 干净：`sqlite3 ~/.jarvis-workbench/jarvis.db "PRAGMA foreign_key_check;"` 无输出
- [ ] migrated_from 审计/回滚对账信息在位（迁移指引文件可读、指明备份位置与回滚方法）
- [ ] 幂等复验：退出再启动一次，不重复搬迁、不报错、数据不变
- [ ] （仅当以上任一失败）回滚演练：按指引文件从 `backups/` 恢复旧库、把失败现象原始报错贴回

## 4. §20.3-8 · 会话完成窗口弹出策略

前置：app 常驻运行、窗口已关闭到托盘。

- [ ] 触发一次 Agent 会话走到「需要用户决策」节点（如 light 轻确认超时前的 decision 请求）：窗口温和置顶约 2 秒后不抢焦点常驻
- [ ] 托盘图标闪烁提示
- [ ] macOS 系统通知出现（点击通知可唤起窗口）
- [ ] 会话正常收口（cancel/完成）路径不再弹窗（只在需要用户时弹）

## 5. #46 · 贾维斯唤醒词 MCP 工作模式（beta.4 新增）

- [ ] 设置 → Token → 「贾维斯唤醒模式」区块可见，默认「单次对话」；切「连续对话」保存成功，重启 app 后仍为连续对话
- [ ] MCP 客户端（重连或新开会话）后对 Agent 说「贾维斯，创建一个任务：明天发布」：Agent 直接进入工作模式建任务、不反问
- [ ] 连续对话模式下操作完成后继续追问看板操作仍走工具；说「退出贾维斯」后回到普通对话
- [ ] 与唤醒无关的普通闲聊不触发看板工具调用

## 6. 收尾

- [ ] 四项全过后把结果回填 `docs/v0.0.4/回归验收矩阵.md`（条款 1/4/68 改「通过—真机轮已过」、§20.3-8 销账），主 agent push 并关 #14
- [ ] 若手动保险副本 `/tmp/atb.db.insure-*` 确认多余可删；`~/.agent-board` 旧目录按迁移指引处置

## 记录区（现象/截图/报错贴这里）

| 项 | 结果（过/挂） | 现象备注 |
|---|---|---|
| §1 条款 1 | | |
| §2 条款 4 | | |
| §3 条款 68 | | |
| §4 §20.3-8 | | |
| §5 #46 唤醒词 | | |
