# v0.0.4-beta.6 真机验证清单（#14 销账）

对象 Release：<https://github.com/xueshuaihui/agent-task-board/releases/tag/v0.0.4-beta.6>（prerelease，tag → `c6b57c6`；内容 = fix/beta6-bug-batch 20 commit（B8 审核产物回退/B8s 产物归属收紧/B9 MCP 设置独立 Tab/B10 设置切换不整页重挂/B11 托盘深色反色 + B12→B13 泳道下线「分组即过滤」+ B14 主导航折叠重做 + B15 Linear 式统一过滤重构）；含 beta.5 全量（bug 批 + 动效 v1.2）与 beta.4 唤醒词。CI run 35888846189 三 job 全绿，Release 由 CI 自动汇集双架构产物）。§1–§6 为 beta.5 存量回归项（其中泳道相关小项已随 beta.6 下线，见 §6.3 标注）；§7 为 beta.6 新增批。§1–§7 全过即 #14 关单、宣布进入预发布。

## 0. 下载与完整性（前置）

- [ ] 按本机架构下载对应 dmg：Apple Silicon → `Jarvis.Workbench_0.1.0_arm64.dmg`；Intel → `Jarvis.Workbench_0.1.0_x64.dmg`
- [ ] 校验 SHA-256 与 Release 内 `SHA256SUMS.txt` 一致（注意 SUMS 内以空格名登记，比对以哈希为准）：
  - arm64：`7d212a46b7151de5d8233602e9a6f799aeeefcf689522b1a2131c46fe1f960ea`
  - x64：`2068c565ba6c443d4633accab4c62954f71128b254037c6efd5a320f0111468d`
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
- [ ] 选中某分组筛选后，可一键回全量（beta.6 起入口改为：视图段「全部」或 chip 条 ×／「清除全部」）
- [ ] 拖动窗口宽度：七列等分铺满、列最小 180px，窄到放不下时整行横滚兜底、卡片不溢出破版（~~泳道视图列宽同规则~~ 泳道已随 B13 下线）
- [ ] ~~换列拖拽四组合~~ 泳道下线后收敛为一种：看板列间拖拽换列（落列后卡片 layoutId 飞行动效可感知、计数正确），另见 §7.4

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

## 7. beta.6 新增批（B8–B11 修复 + B12→B15 分组过滤重构 + B14 导航折叠）

### 7.1 B8/B8s 审核产物

- [ ] 打开一条「本 run 无产物但旧 run 有产物」任务的审核弹窗：展示最近一次有产物的执行并**标注归属**（哪次执行），不再空白
- [ ] Agent 侧：上传产物只认当前执行（旧 run 的 token 上传被拒）；complete 可引用同任务已上传 uri

### 7.2 B9/B10/B11 设置与托盘

- [ ] 设置页出现独立「MCP」Tab（Token 之后），唤醒模式等 MCP 设置都在其中；§5 的唤醒模式切换复验一次
- [ ] 设置各 Tab 快速切换不再整页白屏重挂（内容即时替换）
- [ ] 深色模式/深色菜单栏下托盘图标仍可见（B11 as_template 修正）

### 7.3 B12→B15 统一过滤（重构重点）

- [ ] 看板视图段只剩 看板/列表/流程图（泳道已下线）；旧版存过「主分组=泳道」偏好的设备升级后不报错、过滤正常
- [ ] 工具栏「筛选」弹层可加六维条件（分组/需求/类型/优先级/Agent/标签），维内多选 OR、维间 AND；结果区上方 chip 条逐条可 ×，「清除全部」一键复位
- [ ] 视图段（全部/待我审核/可领取/已阻塞/异常）与筛选叠加正确；「全部」=复位
- [ ] URL 同步：加条件后地址栏为 `#/board?…`，复制该 URL 到新窗口/换设备能完整还原过滤；刷新不丢
- [ ] 偏好迁移：用 beta.5 及以前版本用过分组过滤，升级 beta.6 首开后原分组条件仍在（自动迁成 chip）；已清空的旧分组不会「复活」
- [ ] 过滤态在看板/列表/流程图三视图共用；空列折叠为细条带；960px 最小宽工具栏折行不压字、列横滚兜底
- [ ] 列表页「分组方式」菜单独立于过滤（分节维度本地记忆），筛选 chip 与分节互不干扰

### 7.4 B13/B14 与 dnd 回归

- [ ] 任务列表页 console 无 React validateDOMNesting（thead/tr）报错
- [ ] 主导航折叠：底部「收起导航」整行按钮 / 折叠态轨底图标各点一次；窗口拉窄到 <1200px 自动收成 64px 图标轨，手动折叠态在调宽窗口后保持（显式偏好优先）
- [ ] 看板卡拖拽换列（重构后唯一 dnd 路径）：拖动落列、状态落库、计数即时刷新、layoutId 飞行可感知；过滤态下拖到不可见列外的行为正常

## 8. 收尾

- [ ] §1–§7 全过后把结果回填 `docs/v0.0.4/回归验收矩阵.md`（条款 1/4/68 改「通过—真机轮已过」、§20.3-8 销账、beta.5/beta.6 批各项销账），主 agent push 并关 #14
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
| §7.1 B8/B8s 审核产物 | | |
| §7.2 B9/B10/B11 设置与托盘 | | |
| §7.3 B12→B15 统一过滤 | | |
| §7.4 B13/B14 与 dnd 回归 | | |
