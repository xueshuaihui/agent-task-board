# v0.0.4-beta.5 真机验证清单（#14 销账）

对象 Release：<https://github.com/xueshuaihui/agent-task-board/releases/tag/v0.0.4-beta.5>（prerelease，tag → 本清单回填 commit，SHA 待 CI 后补；内容 = fix/beta5-bug-batch 10 commit（B1 包名切换/B1b 界面旧名/B2 进度条占位/B2b Agent 状态 chip/B3 技能分类/B4 列内滚动/B5 分组复位/B6 MCP 词表/#46 wake mode 修复/B7 列宽弹性 + 主题文案）+ feat/motion-system-v1 16 commit（动效系统 v1.2 全量落地）；含 beta.4 全量修复链）。本分支 CI「创建 Release」job 正常应自动汇集产物（beta.4 时因账单问题手动，若复现按 §0 手动下载口径）。
本清单覆盖矩阵「#14 销账清单」四项：条款 1、4、68 首启、§20.3-8；§5 为 beta.4 唤醒词功能项；§6 为 beta.5 新增批（动效 + 六 bug + B7）。§1–§4 全过即 #14 关单、宣布进入预发布。

## 0. 下载与完整性（前置）

> beta.5 的 dmg 文件名不变（包内版本恒 0.1.0），SHA-256 以 v0.0.4-beta.5 Release 的 `SHA256SUMS.txt` 为准（下方 beta.4 值仅存档）。

- [ ] 按本机架构下载对应 dmg：Apple Silicon → `Jarvis.Workbench_0.1.0_arm64.dmg`；Intel → `Jarvis.Workbench_0.1.0_x64.dmg`
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

## 6. beta.5 新增批（六 bug + B7 + 动效系统 v1.2）

### 6.1 B1/B1b 包名切换（升级重点，先读）

- [ ] **升级前先删除旧 `Jarvis Workbench.app`**（identifier 由 `dev.agenttaskboard.desktop` 换为 `dev.jarvisworkbench.desktop`，macOS 会把新旧视为两个不同 App，不删会出现双图标/双实例）
- [ ] 新 app 窗口标题、托盘菜单项均为「Jarvis Workbench」（不再出现 AgentTaskBoard 旧名；日志目录名 `AgentTaskBoard` 刻意保留，不算挂）
- [ ] 删除旧 .app 后数据不丢：`~/.jarvis-workbench/jarvis.db` 沿用，首启不重复搬迁（幂等，复验 §3 最后一条）

### 6.2 B2/B2b Agent 状态可见性

- [ ] Header 出现「执行中 N · 最近活动 X 分钟前」chip；Agent claim 任务后 chip 计数实时 +1（WS 推送，无需刷新）
- [ ] 执行中卡片的进度条在**无进度数据（第二次执行/刚 claim）时显示占位条**，不再整条消失
- [ ] RUNNING=0 且 24h 内无活动时 chip 整条隐藏不占位

### 6.3 B3/B4/B5/B7 看板与技能交互

- [ ] 技能页分类为平铺多选按钮组（13 分类 chip，「官方/社区」受众词不算分类），多选为 OR 语义
- [ ] 看板任一列卡多时列内竖向滚动；超限时列底出现「还有 N 条」提示
- [ ] 选中某分组筛选后，可一键回全量（下拉选「全部分组」或点分组 chip 的 ×）
- [ ] 拖动窗口宽度：六/七列等分铺满、列最小 180px，窄到放不下时整行横滚兜底、卡片不溢出破版；泳道视图列宽同规则
- [ ] 换列拖拽四组合各验一次不回归：看板→看板、看板→泳道、泳道→看板、泳道→泳道（落列后卡片 layoutId 飞行动效可感知、计数正确）

### 6.4 动效系统 v1.2（docs/motion-spec.md）

- [ ] 微交互统一 140ms/ease-settle：按钮 hover/卡片 hover（-2px 抬升）无残留 120ms 快档
- [ ] 浮层退场可播：Dialog/Drawer/菜单/通知中心关闭时有淡出收口动画（非闪断）；Esc 链正常
- [ ] **450px 矮窗复测 Dialog**（cf8f4f9 三层高度链锚点项）：新建任务/审核表单 Dialog 在矮窗内不溢出、可滚动、按钮可达
- [ ] 全局搜索 ⌘K 浮层开合 140/100ms、键盘链路（↑↓/Enter/Esc）行为不变
- [ ] 列表首屏 stagger（技能库/需求子任务/依赖）约 40ms 间隔、上限 240ms；WS 刷新新项仅单项淡入
- [ ] 系统设置切「深色/浅色/跟随系统」即时换肤无破版（深浅两套色板均已就绪）

### 6.5 B6 MCP 词表（Agent 侧，可与 §5 合跑）

- [ ] MCP 客户端列工具可见 `get_vocabulary`；调用一次返回 task_types/priority/confirmation_mode/状态流转等全词表
- [ ] Agent 传错词表值（如不存在的任务类型）时 422 错误回显可接受值列表，Agent 能据此一次改对、不再试错刷测试数据

## 7. 收尾

- [ ] §1–§6 全过后把结果回填 `docs/v0.0.4/回归验收矩阵.md`（条款 1/4/68 改「通过—真机轮已过」、§20.3-8 销账、beta.5 批各项销账），主 agent push 并关 #14
- [ ] 若手动保险副本 `/tmp/atb.db.insure-*` 确认多余可删；`~/.agent-board` 旧目录按迁移指引处置

## 记录区（现象/截图/报错贴这里）

| 项 | 结果（过/挂） | 现象备注 |
|---|---|---|
| §1 条款 1 | | |
| §2 条款 4 | | |
| §3 条款 68 | | |
| §4 §20.3-8 | | |
| §5 #46 唤醒词 | | |
| §6.1 B1 包名切换 | | |
| §6.2 B2/B2b 状态可见性 | | |
| §6.3 B3/B4/B5/B7 交互 | | |
| §6.4 动效 v1.2 | | |
| §6.5 B6 MCP 词表 | | |
