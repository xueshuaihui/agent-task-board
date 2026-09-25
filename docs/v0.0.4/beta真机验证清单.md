# v0.0.4-beta.7 真机验证清单（#14 销账）

对象 Release：<https://github.com/xueshuaihui/agent-task-board/releases/tag/v0.0.4-beta.7>（prerelease，tag → `5ed5861`；内容 = beta.6 之后 main 全量：G 批（`update_task`/`update_skill` MCP 工具、任务列表列宽 fixed、G-5 看板列宽解耦）+ 0925 编码技能收录 31 条（内置 94→**125**）+ **技能分类两级树化**（0018/0019 迁移、16 叶子、阶段词双角色、服务端 keyword 拼一级）+ C/D 批技能选择器与分类收口存量。CI run 36086497632。§1–§7 为 beta.5/6 存量回归项；§9–§11 为 C/D 与 G 批；**§12 为 0925 批（收录+树化）新增**。§1–§7、§9–§12 全过即 #14 关单、宣布进入预发布。

## 0. 下载与完整性（前置）｜**只能打包 dmg**

> **截至 2026-09-25（tag v0.0.4-beta.7 → `5ed5861` 已切、CI run 36086497632）**：dev 可验面已全绿——§6.2/§6.3/§6.4/§6.5/§7.1/§7.2(前二)/§7.3/§7.4 与 §9–§11 的 dev 腿逐条勾销（批次记录在矩阵「beta.6 之后：dev 演练真机轮」节，该轮修掉 `96f7fb7`/`9777249`/`c3fa31e`/`e27d26e` 四缺陷）；G 批（§10、§11）与 0925 批（§12：31 条编码技能收录 + 分类两级树化）均已在 dev HEAD 真机走查（/tmp 副本环境 c6：两级筛选栏、搜「编码」41 条、双角色两行卡片、0018/0019 增量与 fresh 双路径实测）。**剩余未勾项全部依赖打包 dmg**：§0–§5、§6.1、§7.2-③ 托盘深色可见性、§9 的 beta 包复验腿、§10.1 经典占位滚动条档与 §10.2/§10.3 真实客户端实调、§11 打包环境滚动条挤压与最小窗横滚手势、§12 的包内首启核验（真库 0006→0019 直跳是本批最大真实路径）。

- [ ] 按本机架构下载对应 dmg：Apple Silicon → `Jarvis.Workbench_0.1.0_arm64.dmg`；Intel → `Jarvis.Workbench_0.1.0_x64.dmg`
- [ ] 校验 SHA-256 与 Release 内 `SHA256SUMS.txt` 一致（注意 SUMS 内以空格名登记，比对以哈希为准）：
  - arm64：`7d212a46b7151de5d8233602e9a6f799aeeefcf689522b1a2131c46fe1f960ea`
  - x64：`2068c565ba6c443d4633accab4c62954f71128b254037c6efd5a320f0111468d`
  - 命令：`shasum -a 256 "Jarvis.Workbench_0.1.0_<arch>.dmg"`
- [ ] （建议，非门禁）挂载 dmg 前对旧库手动再拷一份保险副本：`cp ~/.agent-board/atb.db /tmp/atb.db.insure-$(date +%F)`

## 1. 条款 1 · 双击启动 + 托盘图标｜**只能打包 dmg**

- [ ] 挂载 dmg，把 Jarvis Workbench.app 拖入「应用程序」
- [ ] 双击 .app 启动：主窗口正常出现，看板页可交互（首次启动看 §3 迁移现象）
- [ ] 菜单栏（顶部托盘区）出现托盘图标
- [ ] 无 Gatekeeper 拦截无法运行的情况（如被拦：右键 → 打开；记录现象回填）

## 2. 条款 4 · 关窗常驻 + 托盘交互｜**只能打包 dmg**

- [ ] 点窗口关闭按钮：窗口消失但进程常驻（`pgrep -f "Jarvis Workbench"` 仍在；sidecar 端口 `curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:7788/api/v1/tasks` 返回 401 而非拒连）
- [ ] 托盘菜单「打开/恢复」：窗口恢复可见可操作
- [ ] 托盘菜单「退出」：进程真正退出（app 与 sidecar 都消失，端口拒连）

## 3. 条款 68 · 真库首启自动迁移（一次性，重点项）｜**只能打包 dmg，且必须写真库**

场景：本机真实旧库 `~/.agent-board/atb.db`（schema 停 0006、`_prisma_migrations` 账本残缺）→ 首启应自动搬到 `~/.jarvis-workbench/jarvis.db` 并补迁到 0019。

- [ ] 首次启动触发搬迁：`~/.jarvis-workbench/` 生成 `jarvis.db`；旧目录保留原位且有 `backups/` 备份与迁移指引文件（`ls ~/.jarvis-workbench ~/.agent-board`）
- [ ] 迁移水位到 0019：`sqlite3 ~/.jarvis-workbench/jarvis.db "PRAGMA user_version"` = 19（或 `select count(*) from _prisma_migrations where finished_at is not null` ≥ 19），且 0007–0019 迁移对应新表/列存在（如 notification/creation_request 相关表、skills.category 列 + `idx_skills_category`）；**0018/0019 树化核验**：`sqlite3 ~/.jarvis-workbench/jarvis.db "select count(*) from skills where category != '' and category not in ('需求与规划','开发与实现','质量与安全','代码清理','运维与协作','测试自动化','开发编程','教育学习','内容创作','方案写作','投资理财','Office办公','实用工具','数据分析','资讯研究','推荐')"` = 0（用户行旧「质量保障」应已被 0018 直映射为「质量与安全」），默认技能 total=125（0019 归位 + seed upsert 双路收敛）
- [ ] 数据完整保留：旧库里的任务/分组/技能在 UI 中可见、条数对得上（`select count(*) from Task;` 对比旧库副本 `/tmp/atb.db.insure-*`）
- [ ] `PRAGMA foreign_key_check` 干净：`sqlite3 ~/.jarvis-workbench/jarvis.db "PRAGMA foreign_key_check;"` 无输出
- [ ] migrated_from 审计/回滚对账信息在位（迁移指引文件可读、指明备份位置与回滚方法）
- [ ] 幂等复验：退出再启动一次，不重复搬迁、不报错、数据不变
- [ ] （仅当以上任一失败）回滚演练：按指引文件从 `backups/` 恢复旧库、把失败现象原始报错贴回

## 4. §20.3-8 · 会话完成窗口弹出策略｜**只能打包 dmg（桌面壳 + 系统通知）**

前置：app 常驻运行、窗口已关闭到托盘。

- [ ] 触发一次 Agent 会话走到「需要用户决策」节点（如 light 轻确认超时前的 decision 请求）：窗口温和置顶约 2 秒后不抢焦点常驻
- [ ] 托盘图标闪烁提示
- [ ] macOS 系统通知出现（点击通知可唤起窗口）
- [ ] 会话正常收口（cancel/完成）路径不再弹窗（只在需要用户时弹）

## 5. #46 · 贾维斯唤醒词 MCP 工作模式（beta.4 新增）｜**设置面 dev 已过（见 §7.2-①），唤醒链路本身需 app + MCP 客户端**

- [ ] 设置 → Token → 「贾维斯唤醒模式」区块可见，默认「单次对话」；切「连续对话」保存成功，重启 app 后仍为连续对话
- [ ] MCP 客户端（重连或新开会话）后对 Agent 说「贾维斯，创建一个任务：明天发布」：Agent 直接进入工作模式建任务、不反问
- [ ] 连续对话模式下操作完成后继续追问看板操作仍走工具；说「退出贾维斯」后回到普通对话
- [ ] 与唤醒无关的普通闲聊不触发看板工具调用

## 6. beta.5 新增批（六 bug + B7 + 动效系统 v1.2）

### 6.1 B1/B1b 包名切换（升级重点，先读）｜**只能打包 dmg**

- [ ] **升级前先删除旧 `Jarvis Workbench.app`**（identifier 由 `dev.agenttaskboard.desktop` 换为 `dev.jarvisworkbench.desktop`，macOS 会把新旧视为两个不同 App，不删会出现双图标/双实例）
- [ ] 新 app 窗口标题、托盘菜单项均为「Jarvis Workbench」（不再出现 AgentTaskBoard 旧名；日志目录名 `AgentTaskBoard` 刻意保留，不算挂）
- [ ] 删除旧 .app 后数据不丢：`~/.jarvis-workbench/jarvis.db` 沿用，首启不重复搬迁（幂等，复验 §3 最后一条）

### 6.2 B2/B2b Agent 状态可见性

- [x] Header 出现「执行中 N · 最近活动 X 分钟前」chip；Agent claim 任务后 chip 计数实时 +1（WS 推送，无需刷新）（2026-09-24 R-A · dev 实测，按真实 claim/stop 造数；细节见记录区 §6.2 行）
- [x] 执行中卡片的进度条在**无进度数据（第二次执行/刚 claim）时显示占位条**，不再整条消失（R-A · dev。同轮查出并修 1 缺陷：刚 claim 瞬间「最近活动」退化成绝对时间、30s 后自愈，根因 `formatRelative` 把几秒级负 delta 当未来时间 → `96f7fb7` 加 60s 时钟抖动容差 + 3 单测）
- [x] RUNNING=0 且 24h 内无活动时 chip 整条隐藏不占位（R-A · dev，含 2h 对照，证明是规则生效而非请求挂）

### 6.3 B3/B4/B5/B7 看板与技能交互

- [x] 技能页分类为平铺多选按钮组，多选为 OR 语义（2026-09-24 分类收口后口径：分类选项恒为技能 `category` 列的 12 项受控词表 +「未分类」，不随任何技能的 tags 漂移；~~13 分类 chip、「官方/社区」受众词按 tags 减法剔除~~ 旧减法口径作废，「官方/社区」受众徽标一并下线，见 PRD §19.13-82）（R-A · dev：13 chip 计数与卡片数吻合、OR 语义实测）
- [x] 看板任一列卡多时列内竖向滚动；超限时列底出现「还有 N 条」提示（R-A · dev：把 `board_column_limit` 调到下限 10 造超限后已还原）
- [x] 选中某分组筛选后，可一键回全量（beta.6 起入口改为：chip 条逐条 × 或「清除全部」。**注意：视图段的「全部」不是过滤复位入口**，它只把视图作用域复位成不加限定，已加的过滤条件会原样保留——2026-09-24 R-D 真机实测：`?priority=1&type=缺陷&groups=grp_default` 三条件下点「全部」，URL 只掉 `view=`、三个 chip 仍在）（R-A/R-D · dev 过）
- [x] 拖动窗口宽度：七列等分铺满、列最小 180px，窄到放不下时整行横滚兜底、卡片不溢出破版（~~泳道视图列宽同规则~~ 泳道已随 B13 下线）（R-A · dev：960px 七列等分铺满不压字、180px 下限与横滚兜底实测）
- [x] ~~换列拖拽四组合~~ 泳道下线后收敛为一种：看板列间拖拽换列（落列后卡片 layoutId 飞行动效可感知、计数正确），另见 §7.4（R-E · dev 合成 Pointer 拖 T-1010 换列并拖回，落库与计数实测；layoutId 只测到「拖拽期有动画在跑」，未逐帧分辨，见 §7.4 末残留）

### 6.4 动效系统 v1.2（docs/motion-spec.md）

- [x] 微交互统一 140ms/ease-settle：按钮 hover/卡片 hover（-2px 抬升）无残留 120ms 快档（2026-09-24 R-B 实测：`duration-120` 全仓 **0 处**（原 20+ 处已并档，`duration-140` 87 处）；看板卡与按钮、chip 的 computed `transitionDuration=0.14s` + `cubic-bezier(0.2,0,0,1)`=settle，卡带 `hover:-translate-y-0.5`（-2px）。唯一 120ms 是 `tooltip.tsx` 的入 120/出 100，spec §1.L2 表明定该档、属豁免不是残留）
- [x] 浮层退场可播：Dialog/Drawer/菜单/通知中心关闭时有淡出收口动画（非闪断）；Esc 链正常（R-B WAAPI 逐帧采样，时长与 spec §1.L2 表逐条对齐：抽屉 Esc 关闭 = 遮罩 DIV **140ms** + 面板 ASIDE **180ms**（带 translateX 位移）；通知中心关闭 = 遮罩+面板两条同退，opacity 0.97→0.80→0.63→0.47→0.11→0.00 约 210ms 收口、**退完才卸载**（200ms 后节点消失，之后 3s 无回闪）；搜索下拉 Esc 关闭 = **100ms** 纯淡出后 ~128ms 卸载。Esc 层级：下拉开着时 Esc 只关下拉、页面不留 overlay；抽屉→列表页逐层关正常）
- [x] **450px 矮窗复测 Dialog**（cf8f4f9 三层高度链锚点项）：新建任务/审核表单 Dialog 在矮窗内不溢出、可滚动、按钮可达（R-B 用同源 iframe 造出 **956×446** 真视口：新建任务 Dialog `documentElement.scrollHeight - innerHeight = 0`（页级不溢出）、内容区 `.atb-scroll` scrollHeight 456 > clientHeight 289（**可滚**）、底部「取消/创建」bottom=406 ≤ 446（**可达**）；同尺寸下看板列容器列内滚兜住（需求池 clientHeight 186 / scrollHeight 1650，`body.scrollWidth-innerWidth=0` 不破版，即 R-A 留的「450 高下列内滚不退化成整页滚」红线复验过）。**审核表单也已补量**（2026-09-24 R-C-2，同 956×446 iframe 走看板→抽屉→审核弹窗）：页级 `446 − 446 = 0` 不溢出、弹窗内唯一滚容器 `.atb-scroll` scrollHeight **1077** > clientHeight **289**（可滚）、「取消/提交审核」bottom **406 ≤ 446**（可达），且 B8 归属标注与产物行在矮窗下渲染无裁切）
- [x] 全局搜索 ⌘K 浮层开合 140/100ms、键盘链路（↑↓/Enter/Esc）行为不变（R-B 真机：⌘K + 输入即开，入场面板 140ms、8 条候选；↓ 使 active 从 T-1006 移到 T-1007；Enter 直接开该任务详情抽屉（ASIDE 淡入 0.56→1）；Esc 逐层关。下拉行自身在 0 延迟档瞬时到位，与面板 140ms 同档）
- [x] 列表首屏 stagger（技能库/需求子任务/依赖）约 40ms 间隔、上限 240ms；WS 刷新新项仅单项淡入（R-B：技能库首屏逐帧采到 running 动画的 delay 集合恰为 **{0,40,80,120,160,200,240}**（40ms 档、240ms 封顶，长列表不拖尾）；WS 新建任务只让**那一张卡**动画（同屏 21 张卡里仅 1 个 ARTICLE 在跑），不重放 stagger。**偏差已裁定（2026-09-24）**：新卡入场淡入实现取 `itemVariants` 的 240ms、spec §168 原写 200ms——裁定为**改规范跟实现**（240 与列表入场子项同源，拆独立 200ms 档要多加一份 variant），motion-spec §5-1 与 §5.2 回落规则已同步改 240ms 并记裁定，代码不动）
- [x] 系统设置切「深色/浅色/跟随系统」即时换肤无破版（R-B：三档连点两圈，body 底色 light `rgb(244,245,250)` ↔ dark `rgb(15,17,24)` 即时互切（200ms 色彩过渡，globals.css `--ease-settle`），每档 `documentElement.scrollWidth - innerWidth = 0` 无横向破版，验完已复原「跟随系统」。附带确认：卡片进度占位条 `atb-progress-indeterminate` 是 1200ms 无限循环动画，属 B2b 设计内、不是失控动画）

### 6.5 B6 MCP 词表（Agent 侧，可与 §5 合跑）

- [x] MCP 客户端列工具可见 `get_vocabulary`；调用一次返回 task_types/priority/confirmation_mode/状态流转等全词表（2026-09-24 R-C-1 **协议层**实测：对无状态 Streamable HTTP `POST /mcp`（Bearer agent token，JSON-RPC，非 mock）发 `tools/list` → 26 个工具含 `get_vocabulary`；`tools/call get_vocabulary {}` 一次拿全 `task_types.default/current=[需求,缺陷,子任务,巡检,重构]`、`priority.values=[0,1,2,3]`+中文档名+default、`confirmation_mode`（direct/light/silent + 语义 + 优先级）、`task_status.values=[BACKLOG,READY,RUNNING,BLOCKED,REVIEW,DONE,FAILED]` + `transitions` 全表（RUNNING 只能由 claim 产生、DONE 终态、REVIEW 出边需审核表单）、capability 命名空间规则、skill 类型/状态/来源、`artifact_types`+uri_rule、`log_level`、breakdown 会话状态。**仍待补**：在真实 MCP 客户端（Qoder）会话里肉眼确认工具列表可见——客户端只是渲染同一份 `tools/list`，随 §5 合跑时补一眼）
- [x] Agent 传错词表值（如不存在的任务类型）时 422 错误回显可接受值列表，Agent 能据此一次改对、不再试错刷测试数据（R-C-1 实测：REST `POST /tasks {"type":"TODO"}` → **422** `任务类型「TODO」不在词表内` + `details[{path:type,code:unknown_type,message:"可选：需求 / 缺陷 / 子任务 / 巡检 / 重构"}]`（`"数据同步"` 同形态）；`transition {"to":"TODO"}` → **422** `invalid_value` 且 message 直接列出 7 个合法状态；MCP `board.create_task type=TODO` → HTTP 200 信封 + `isError:true`，`content[0].text` 内有完整 422 体含可接受值。**同轮查出并修 2 处回显折损**：①`structuredContent` 只带 `{code,message}`，把可接受值整块丢了（`mcp.server.ts` 的 `toCallToolResult` catch 分支只并 `error.context` 不并 `details`），而只解析 structuredContent 通道的客户端正是 B6 要救的那类——已随本批补上 details（追加式，`code/message` 契约不变）；②`priority:9` 被 MCP SDK 自身 schema 先挡下（`-32602 Too big: expected number to be <=3`），走不到 B6 的 hint 路径、因此不产出可接受值列表——**已知现象，本轮不改**（改法是给 input schema 加字段描述/放宽到词表校验，属另行裁定））

## 7. beta.6 新增批（B8–B11 修复 + B12→B15 分组过滤重构 + B14 导航折叠）

### 7.1 B8/B8s 审核产物

- [x] 打开一条「本 run 无产物但旧 run 有产物」任务的审核弹窗：展示最近一次有产物的执行并**标注归属**（哪次执行），不再空白（2026-09-24 R-C-2 真机：演练任务 T-1020（当前 R-2007 零产物、R-2006 有 1 产物）从**两个入口**（看板→详情抽屉「审核 →」与审核页行内「审核」，二者复用同一 `ReviewFormDialog`）打开后 DOM innerText 实测——执行摘要锚定 `R-2007 / 第 2 次执行`；归属标注原文「本次执行没有回传产物；以下为该任务最近一次有产物的执行（第 1 次 · R-2006）。」（`review-form.tsx:445-449` 的 `<p class="-mt-2 text-aux text-text-tertiary">`）；「其他产物」区列出 `r-c1-run1.txt / 24 B`，**预览**拉出内容「r-c1 artifact from run1」、**下载** GET 成功无报错。反证判据（显示 0 产物/空态即挂）未触发。**同轮查出并修 1 处文案排版**：JSX 把「（第」与 `{run_number}` 之间的换行空白折叠，实机渲染成「第1 次」，与同弹窗「第 2 次执行」风格不统一——加 `{' '}` 修掉（`e27d26e`，全仓其余「第 N 次」拼接逐条核过无同类漏网））
- [x] Agent 侧：上传产物只认当前执行（旧 run 的 token 上传被拒）；complete 可引用同任务已上传 uri（2026-09-24 R-C-1 真机跑通全链路：建任务→transition READY→claim 拿 run/lease→上传→complete。**正例** 当前 run 上传 201；**拒例** 任务已重跑（当前 R-2007）后拿旧 R-2006 上传 → **409 `TASK_NOT_RUNNING`**「run_id R-2006 不是任务 T-1020 的当前执行…请重新领取任务并用新的 run_id 上传」+ detail `not_current_run/current_run_id=R-2007`；run 不属于该任务 → 404；complete 引用从未上传的 uri → **422** `details[{path:"artifacts.uri",code:"not_uploaded"}]`；UI token 打上传接口 → 403 `FORBIDDEN`。**引用旧 run 已上传 uri 的 complete → 200**（R-2007 零上传仍收口 SUCCESS/REVIEW，产物行仍归 R-2006 未被改写，即 `assertUploadedArtifacts` 按 taskId 查的 B8s 口径）。另核掉一条早先怀疑：`POST /artifacts` 的 `uri` 由服务端 `buildArtifactUri(taskId,runId,id,ext)` 自造、调用方传不进来，所以「跨 run 传同一个 uri 被静默去重致 complete 找不到行」在当前模型里不可能发生（唯一吃调用方 uri 的是 complete 里的 `link`，按 run 去重是设计内），**不是挂**。两点如实记的口径偏差（验条措辞 vs 实现，需产品裁定，见 §7.1 末）：①守卫是 **run 维度不是 token 维度**——另一个 agent token（从未 claim）向他人当前 run 上传照样 201，拿别人的 `task_id/run_id/lease_id` 三元组 complete 也照样 200，故「旧 run 的 token 被拒」准确表述是「非当前 run_id 被拒」；②判据 `task.currentRunId === run_id` **不校验任务状态**，任务已 REVIEW（租约已清、run 已 SUCCESS）后再向 current_run_id 上传仍 201）

**裁定（2026-09-24 拍板：两条都只记档，不改）**：B8s 的意图就是「产物别挂到过期 run 上」，不承担「调用方身份」与「任务状态」两道收紧，故以下两条按设计内记档、代码不动，验条措辞已改为「非当前 run_id 上传被拒」：
1. **归属守卫按 run 不按 token**：任何通过 `@AuthScope('agent')` 的 agent token 都能往别人的当前 run 上传产物（实测 201），甚至拿别人的 `task_id/run_id/lease_id` 三元组调 complete（实测 200）。若日后要把「产物属于哪次执行 = 谁 claim 的」变成硬约束，缺的一步是 `run.tokenId === 调用方 token`。
2. **不校验任务状态**：判据只有 `task.currentRunId === run_id`，任务已 `REVIEW`（租约已清、run 已 SUCCESS）后再向 `current_run_id` 上传仍回 201。要收紧就是再加 `task.status === RUNNING`。

### 7.2 B9/B10/B11 设置与托盘

- [x] 设置页出现独立「MCP」Tab（Token 之后），唤醒模式等 MCP 设置都在其中；§5 的唤醒模式切换复验一次（2026-09-24 R-C-2 真机：设置侧栏 DOM 顺序 = 通用/视图/Token/**MCP**/字段定义/模板/数据/日志与审计/备份/关于，MCP 紧随 Token ✓；Token Tab 全文只剩「Agent 接入/生成 Token/Token 列表/吊销」，无「唤醒模式」字样 ✓，「唤醒后的会话模式」RadioGroup 已在 MCP Tab 的「工作模式」分组内 ✓；单次→连续后 `GET /settings` 回 `mcp_wake_mode: continuous`，`location.reload()` 与深链 `#/settings?tab=mcp` 后 radio `data-state=checked` 仍在「连续对话」，**验完已还原 single**（后端复核 + 审计两条 `single↔continuous` 留痕）。**dev 测不了的一半**：「重启 app 后仍在」需桌面壳，随 §5 在 beta 包复验）
- [x] 设置各 Tab 快速切换不再整页白屏重挂（内容即时替换）（R-C-2 可证伪实测，共 **14 次**切换、覆盖 10 个 Tab：切换前给 `nav.dataset.mark='1'` 打标记并保存节点引用，14 次后标记仍在且 `nav`/`header` 为**同一节点对象**（壳未重挂）；`performance.getEntriesByType('resource')` 中 `initiatorType==='document'` 条数 **0 → 0**（无整页 reload）；点击 → `main h2` 文本变化的耗时 **18–46ms**（1–3 帧，无白屏帧）；`window.onerror` 空、console 无新增 error/warning。逐 Tab 走查也无白屏 Tab、无按钮不可达，空列表处均为带文案的受控空态）
- [ ] 深色模式/深色菜单栏下托盘图标仍可见（B11 as_template 修正）——**只能真机**：需打包 dmg 与 macOS 菜单栏，dev 环境无桌面壳，随 §1–§2 一轮验

### 7.3 B12→B15 统一过滤（重构重点）

- [ ] 看板视图段只剩 看板/列表/流程图（泳道已下线）；旧版存过「主分组=泳道」偏好的设备升级后不报错、过滤正常
- [ ] 工具栏「筛选」弹层可加六维条件（分组/需求/类型/优先级/Agent/标签），维内多选 OR、维间 AND；结果区上方 chip 条逐条可 ×，「清除全部」一键复位
- [ ] 视图段（全部/待我审核/可领取/已阻塞/异常）与筛选叠加正确：二者是**正交两轴**——视图段是作用域限定、chip 条是过滤条件，叠加后 URL 形如 `#/board?view=claimable&priority=1&type=缺陷`，工具栏给「视图：可领取 · 已筛 2 项」。**「全部」=视图作用域复位（不是清空过滤）**，过滤条件的复位入口只有 chip 条 × 与「清除全部」（旧文案把「全部」当成一键回全量，2026-09-24 R-D 实测后更正，与 §6.3 同口径）
- [ ] URL 同步：加条件后地址栏为 `#/board?…`，复制该 URL 到新窗口/换设备能完整还原过滤；刷新不丢
- [ ] 偏好迁移：用 beta.5 及以前版本用过分组过滤，升级 beta.6 首开后原分组条件仍在（自动迁成 chip）；已清空的旧分组不会「复活」
- [ ] 过滤态在看板/列表/流程图三视图共用；**看板空列不折叠**——恒占一列宽并显示「暂无任务」，加筛选前后七列宽度逐像素一致（G-5 拍板，见 §11；本条旧文案写的是「空列折叠为细条带」，该规则已整体作废）；960px 最小宽工具栏折行不压字、列横滚兜底
- [ ] 列表页「分组方式」菜单独立于过滤（分节维度本地记忆），筛选 chip 与分节互不干扰

### 7.4 B13/B14 与 dnd 回归

- [x] 任务列表页 console 无 React validateDOMNesting（thead/tr）报错（2026-09-24 R-E 实测：`#/tasks` 全新加载后 console 无 validateDOMNesting 类报错，该项过。**同屏曾有另一类 error**，见下条，已修）
- [x] （R-E 发现并已修，`9777249`）`#/board` 与 `#/tasks` 纯挂载即各出 3 条 React error「Function components cannot be given refs…forwardRef()」，栈顶均为 `AnimatePresence` → `Primitive.div.Slot` → `Portal` → `Presence`，落点 = `components/ui/tooltip.tsx`（board 由 BoardToolbar、tasks 由 task-list/cells.tsx TitleCell 触发）、`app/notification-center.tsx` 的 Dialog、`features/dependency-graph/DependencyGraphDialog`。**根因不是 Content 上的 motion 元素**（motion 13.4 的 `motion.span/div` 都是 forwardRef），而是直写在 `Portal forceMount` 里的 `<AnimatePresence>` 本身：Radix Portal 内部是 `<Presence><Portal asChild>{children}</Portal></Presence>`，Slot 用 `cloneElement(child,{ref})` 把 Presence 的合成 ref 转给唯一子节点，而 motion 的 AnimatePresence 是无 forwardRef 的普通函数组件，React 18.3.1 遂告警并丢 ref（forceMount ⇒ 与 open 无关、纯挂载即报；drawer 同形状潜伏，走查时未挂载故未现）。修法：AnimatePresence 移到 Portal 外（与已上线的 popover/menu 同构），四处 forceMount 保留。复验：board/tasks 挂载 console 归零，通知中心关闭 WAAPI 采到遮罩 DIV + 面板 ASIDE 两条动画 opacity 0.97→0.00（~210ms）后才卸载、退场未回归
- [x] 主导航折叠：底部「折叠导航」整行按钮 / 折叠态轨底「展开导航」图标各点一次（按钮实际文案是「折叠导航」，验条旧写作「收起导航」，2026-09-24 R-E 实测更正）；窗口拉窄到 <1200px 自动收成 64px 图标轨，手动折叠/展开态在刷新后仍在（`atb.nav.collapsed` = '1'/'0'/缺失三态；缺失才跟随断点，显式偏好优先于断点，2026-09-24 R-E 实测：767px 窄窗口下 `pref='0'` 恒 200px、清偏好后回 64px 自动收起）
- [x] 看板卡拖拽换列（重构后唯一 dnd 路径）：拖动落列、状态落库、计数即时刷新、layoutId 飞行可感知；**过滤态下拉到列后卡片仍按过滤结果呈现**（旧文案「拖到不可见列外」是泳道时代口径——B15 起列恒为七列、过滤维不含状态，不存在「不可见的目标列」，2026-09-24 R-E 更正）。R-E 实测：合成 Pointer 序列把 T-1010 需求池→待执行，1.2s 内两列卡片归属互换、`GET /tasks?keyword=T-1010` 回 `status=READY`（落库）、再拖回为 `BACKLOG`、全程 console 无新报错。**残留如实记**：「layoutId 飞行可感知」只测到「拖拽期间确有动画在跑」，R-E/R-B 两轮都没逐帧分辨出是 layoutId 共享动画（§6.4 记录行同口径），此项留待 beta 包肉眼确认

## 8. 收尾

- [ ] §1–§7 全过后把结果回填 `docs/v0.0.4/回归验收矩阵.md`（条款 1/4/68 改「通过—真机轮已过」、§20.3-8 销账、beta.5/beta.6 批各项销账），主 agent push 并关 #14
  **dev 侧那一半已做**（2026-09-24，矩阵新增「beta.6 之后：dev 演练真机轮 R-A~R-E / R-C-1~2」批次记录节，含逐节状态表、四条修复 commit 与三条拍板落盘）；**未做的一半**：条款 1/4/68 与 §20.3-8 改「通过—真机轮已过」必须由打包 dmg 那轮触发，本轮不销、#14 不关。
- [ ] 若手动保险副本 `/tmp/atb.db.insure-*` 确认多余可删；`~/.agent-board` 旧目录按迁移指引处置（**属 §3 真库迁移那一轮的动作**，dev 轮不碰真库，故本轮未动）

## 9. 新增批：技能分类一套标准 + 统一技能选择器（C/D 批，2026-09-24 写回）

内容：技能分类收口读写侧（C-4 `5eec3df` / C-5 `d6439df`）、分类展示面收口（C-6b① `28041cb`）、「选技能」四处接线（D-1 `258d5d4` / D-2 `1003ed8` / D-3 `72f67f5` / D-4 `8b9e54c`）、选择器行模型与名称窗口化（C-6b②③ / C-6c，`28041cb` / `ce43347`）。除标注「待验」的项外，本批各条均已在 dev 浏览器真机走查过（实测数字在 commit message 里），本节按 beta 包复验销账。

### 9.1 技能分类一套标准

- [ ] **卡片分类可见**：技能库页 → 每张技能卡徽标行：有带图标、中性底的分类徽标（未设分类显示「未分类」），文案 = 该技能实际存的 `category`；与右侧 primary 底的自由标签 chip 视觉分家，`tags` 里「开学季」这类词只以标签出现、不再冒充分类（C-6b①，`28041cb`）
- [ ] **详情抽屉分类独立成行**：点卡片开详情抽屉 →「分类」在顶部独立成行（不混进状态/标签那一排），值与卡片、筛选器一致（C-6b①，`28041cb`）
- [ ] **编辑器分类单选**：进技能编辑器 → 结构化表单：「分类」为 12 受控词 + 未分类共 13 项单选，初始选中 = 技能实存值；切换保存后卡片/抽屉徽标与筛选器计数同步变化且一致；默认技能（只读）该字段置灰但完整可见（C-5，`d6439df`）
- [ ] **筛选器 13 项计数**：技能库页顶部「分类」筛选行：选项恒 13 项（12 词表 + 未分类，未分类恒最后），每项计数 = 库内实际存该 `category` 的技能条数；多选为 OR 语义，筛后卡片数与计数吻合，计数 0 的项置灰但不消失（C-4，`5eec3df`；PRD §19.13-82）
- [ ] **`GET /skills` 无 `category=`**：开 devtools Network → 技能库页点选/取消分类筛选：分类过滤全程零新增请求、`GET /skills` 的 URL 参数里始终不出现 `category=`（纯前端过滤）。**注意：列表页自身的搜索框是列表的服务端 keyword 筛选轴，它发 `?keyword=` 请求是既有设计、不在本批口径与「选择器零请求」范围内，勿误报**（C-4 裁定 / D-4 口径，`5eec3df`/`8b9e54c`）

### 9.2 技能选择器四处统一

- [ ] **四处同一组件（三处已过 · 一处待验）**：依次打开任务详情页 → 技能 Tab 的绑定区、技能编排编辑器 → 子技能块的技能引用下拉、技能库页 → 新建技能 ▾ → 复制现有技能（弹窗），对照：搜索框 + 候选面板同一套结构与行为，无自绘列表。**拆解草案的技能多选面板（PRD §7.4）尚未真机走查——需要一个真实拆解会话走到草案页，目前仅有单测背书，该处待验、不得随本条销账**（D-2/D-3/D-4，`1003ed8`/`72f67f5`/`8b9e54c`）
- [ ] **本地零请求搜索**：devtools Network 打开，在上述任一选择器搜索框逐字输入/删除查询：搜索过程零新请求，候选本地实时收窄/还原（技能列表仅面板所在页挂载时一次性全量取回）；复制技能弹窗不再每按键打一次服务端搜索（那是 D-4 之前的旧现象）（D-1–D-4，`258d5d4`–`8b9e54c`）
- [ ] **六面命中 + 高亮**：依次输入某技能名称词、描述词、分类词（含「未分类」）、类型英文 `workflow` 与中文「工作流」、自由标签、完整 `id` 与 `id` 后 6 位（照着屏上消歧后缀输入）：均应命中且命中片段高亮；多词查询任一词六面皆空则该技能出局（AND 语义）（D-1，`258d5d4`）
- [ ] **分组态行模型**：空查询：按 `分类（条数）` 分组、未分类恒最后；行只有名称 + 版本号——无逐行类型/状态徽标，且**不再有 JS 提前截断**（C-6b 曾按固定 24 字符截，把 `boge-kaoyan-writing-coach` 截成假省略号，C-6c 起分组态恒全名直出）；渲染层 CSS 省略号仍保留作超长名兜底——320px 弹层里 20 字 CJK 名这类极端长度会截尾，这是设计内的退化形态、不算挂（C-6b②/C-6c①，`28041cb`/`ce43347`）
- [ ] **查询态行模型**：输入查询后：行 = 名称 + 类型中文标签徽标 + 版本号；搜分类词（如「数据分析」）时仅命中落在分类上的行额外出分类文本；任何状态下面板行内都不出现「草稿/已发布」状态徽标（候选排除归调用方，任务详情绑定区看不到 `ARCHIVED` 是调用方过滤的结果、与本条两码事）（C-6b②/C-6c①，`28041cb`/`ce43347`）
- [ ] **长名窗口化命中必可见**：用窄弹层（子技能引用的 320px 弹层）搜只命中超长名尾部的词——拉丁例 `18steps`（命中 `financial-analysis-18steps`）、中文例搜「练习」（命中 20 字 CJK 长名尾部）：名称被以命中为中心开窗、两侧与段间带 `…`，**高亮片段必须完整可见**、不被 CSS 省略号吞掉；名称零命中的超长名（如命中只在分类）恒全名、无 JS 截断（C-6b②/C-6c②，`28041cb`/`ce43347`）
- [ ] **重名消歧后缀可分辨**：先用「复制现有技能」造一个副本（名称自动加「副本」、同名不同 `id`）→ 看任一选择器空查询分组态：原件与副本两行名称都完整、行尾 ` ·id后6位` 后缀**都完整可见**（后缀渲染在截断区之外，名称再长也不被省略号吞），两行一眼可分辨；悬停行显示全名 + 后缀（C-6c③，`ce43347`）
- [ ] **复制弹窗打开即聚焦可打字**：技能库页 → 新建技能 ▾ → 复制现有技能：弹窗打开瞬间焦点已在搜索框（光标在闪），直接打字即过滤，无需先点输入框或按 Tab（C-6b 时原生 autoFocus 被 Dialog 抢焦、真机判否，C-6c 换挂载后显式 focus）；选中即收弹窗并创建名称带「副本」后缀的新草稿（C-6b③/C-6c④，`28041cb`/`ce43347`）

## 10. 新增批：用户报障 G 批（任务列表列宽 + Agent 编辑面，2026-09-24 写回）

用户当日报三条：①「任务列表选择筛选项后样式出问题、列宽发生变化」（补充口径：**有内容的列宽度变大，每一列都有内容时不会出现**）；②「agent 客户端修改编辑贾维斯任务的能力有残缺」；③「同样的编辑技能的能力也有欠缺」。②③拍板=**全字段通用 PATCH**；`update_task` 的写权限守卫拍板=**持租约可改 + 未认领可改**。

### 10.1 G-1 任务列表列宽（`ac5b45a` + `8c1d550`）

- [x] 根因定性：表根是 `w-full min-w-[960px]` + 默认 `table-layout:auto`、无 `<colgroup>`，th/td 上的宽度类在 auto 里只是首行「建议值」，每列最终宽度由**当前渲染出来的行内容**推导。三个同源放大器：过滤换掉可见行集、分组方式切换向 tbody 插 `colSpan` 分节行、chip 汇总条出现/消失改变纵向滚动条（±15px 被 auto 按比例摊到所有列——修复前实测 89.2 / 87.2 / 95.3 / 157.4 这类小数即摊薄证据）。工具栏与 chip 条本来就是 `flex-wrap`，不是挤压所致。
- [x] 修法（修模不修症状）：`Table` 新增可选 `columns` prop → `table-layout:fixed` + `<colgroup>`，列宽唯一真值收敛到 `features/task-list/columns.ts`，表头由该模型 map 渲染（`<colgroup>` 与 `<th>` 永远同列同序）、td 宽度类全删、分节行 colSpan 读模型长度；批量结果弹窗表同口径收口；技能结构化编辑器**不改**（摘要列是 `hidden md:table-cell` 响应式列，`<md` 时该列整体不存在，colgroup 会与渲染列错位反而破版）；设置页全系本来就是显式 `grid-cols-[...]` 轨道，无需改。
- [x] 真机复验（1280 / 1800 / 960 三档 × 四种渲染形态）：11 列在 20 行 / 1 行 / 0 行（EmptyState）/ 分组分节行（colSpan=11）下**逐列像素恒定** = [40, 80, 228, 72, 78, 96, 112, 112, 64, 96, 52]；11 个表头高度全部 44px（无折行）、表头内层文本 `scrollWidth ≤ clientWidth`（无截断）；20 行 × 11 格全扫描**零内容溢出到邻列**；1800 档定宽 10 列不动、标题列独吞 640px（弹性列只有标题一个）。
- [x] 中途查出的回归已收：首版整表地板 1150 在 1280 档引入了**修复前不存在**的容器内横滚（本页水平外框恒 250px → 容器宽 = 视口 − 250 = 1030 < 1150；把同一容器回退模拟成旧 auto 布局实测 `tableW 1030 / scrollW 1030 / clientW 1030` 恰好塞得下）→ 地板收到 **1022**（定宽合计 802 + 标题保底 220），1280 档实测 `clientW 1030 / scrollW 1030` 零横滚、标题 228 与旧实渲 228.2 几乎逐像素一致；960 档守住已验收口径（`documentElement.scrollWidth 960 = innerWidth` 页面零横向溢出，横滚只在 `.atb-scroll` 容器内、表头吸顶与行 hover 指示条未退化）。
- [ ] 待 beta 包复验：macOS **经典（占位）滚动条** 15px 会真的挤掉容器宽（dev 机是覆盖式滚动条，测不出这一挤），需在打包 dmg 里看 1280 档是否仍不横滚（地板 1022 距 1030 只有 8px 余量）。

### 10.2 G-2 `update_task`（`4dc8764`，MCP 工具 26→27）

- [x] 守卫三支：`RUNNING` 必须带该任务**当前**租约三元组（`leases.verify`，与 `update_progress` 同口径，过期/吊销/非当前持有者沿用既有 410/412 语义）；`BACKLOG`/`READY`（未认领）**免租约可改**（拆解/建单 Agent 修正自己产出的子任务）；`BLOCKED`/`REVIEW`/`DONE`/`FAILED` 拒 409 新码 `TASK_NOT_EDITABLE`，`details` 与 message **指名该走哪条链路**（BLOCKED 租约已清空只能人工转回 READY 重新认领 / REVIEW 走审核结论 / DONE 是终态请新建后续任务 / FAILED 重开再认领），B6「一次改对」口径。
- [x] 字段面**逐字取 REST `taskPatchSchema.shape`**（13 个可写字段，同一批 zod 实例），字段级校验（type 词表 + 可接受值回显、priority 0-3、tags、skills 归属/版本、parent 层级 ≤2、group 存在、custom_fields 增量合并）与审计/事件只有 `TasksService.applyPatch` 一份实现，Agent 面走 `patchAsAgent` 窄入口。**REST 行为一字未动**：`PATCH /tasks/:id` 对 RUNNING 仍 `TASK_RUNNING`（既有 `state-machine.test.ts:205` + 本轮新增的 REST 红线用例双向锁住），审计 `actorType` 分 user/agent。
- [x] 越权面：`status` / `assignee` / 租约列根本不在可写键里，状态机与执行权改不到（MCP 协议层按 inputSchema 先剥未声明键，非 HTTP 直连通道才由 `.strict()` 报 422）。
- [ ] 待 beta 包/真机：Qoder 客户端里 27 个工具可见、`update_task` 实调一次（dev 只验到 `InMemoryTransport` 全链路 17 用例）。
- 已记档的两个已知边界（不在本片修）：①`updateTask` 读状态与写入之间是毫秒级窗口，人在这几毫秒里强制停止则守卫判的是旧状态——与 REST `patch()` **同风险面**（现有实现本来也是读后写），要收严应在 `applyPatch` 内做 `updateMany where status=before.status` 乐观并发，那是独立一条改动；②`parseToolInput` 的 `received` 回显对**所有**工具生效，若将来某工具的枚举字段承载凭证/隐私值，会把原值带进错误体（当前 28 个工具入参不含 token 类字段，判断为可接受；收紧口径可对 `*_token`/`secret` 路径掩码）。

### 10.3 G-3 `update_skill`（`3ae627f`，27→28）

- [x] 可写面 = UI `skillPatchSchema` 除 `status` 外的全部（`name` / `description` / `category` / `tags` / `content` / `test_cases`）。**`status` 有意排除**，理由是模型一致性不是保守：UI 的「发布」是 `POST /skills/:id/versions`（服务端自增 semver 并设 current）**加上** `PATCH {status:'PUBLISHED'}` 两步（`apps/web/src/features/skills/hooks.ts:102`），而 agent 面没有版本快照工具，只给 status 会让没快照的 content 被标成已发布、`current_version` 与内容脱节；`mcp_dependencies` 与 UI 的 PATCH 面一致不可写（它只在创建与版本创建里出现）。
- [x] 守卫与校验全复用 `SkillsService.patch` 那一份：内置默认技能（`source='default'`，随包更新的 125 条，0925 收录+树化后口径见 §12）→ `SKILL_READONLY`、改到 content 时子技能自引用/成环 → `SKILL_REF_SELF` / `SKILL_REF_CYCLE`（`details.chain` 给环路径）、分类越表 422（0925 树化后越表面 = 纯分组一级 + 作废词 + 表外词，见 §12）。`skills.controller.ts` 的 `@AuthScope('ui')` **未动未摘**（agent 面走 MCP 工具→服务方法，与 HTTP scope 无关，与既有 `list_skills` 同口径）。
- [x] 词表回显补在 **agent 入口这一层**（REST 的 422 只有裸 zod 三键 `Invalid option: expected one of …`，UI 控件回填在用，一字未改，新测试专门锁住它不含 `received`/`hint`）：`parseToolInput` 的 details 追加 `received`（zod `invalid_value` issue 实测不带受值），hint 拼「可接受值：…；当前收到 …」，`get_vocabulary` 新增 `skill_categories`（12 词 + `''`=未分类，与 `task_types` 同形状）。
- [ ] 待 beta 包/真机：同上，客户端实调 `update_skill`（含「改正文必须先 `get_skill` 拿整份 content 再回提，`content`/`tags`/`test_cases` 都是整体覆盖」这条教义在真实客户端里是否被 agent 遵守）。

**本片门禁**：api `npm run typecheck` 干净、`npm test` **63 files / 683 tests 全绿**（G-2 前基线 61/650 → G-2 +17 → G-3 +16，零删零 skip 零放宽期望）、`scripts/boot-smoke.sh` PASS ×2；web `npx tsc --noEmit` 干净、`npx vitest run` **13 files / 119 tests 全绿**、`npx vite build` 产物 CSS 内 `min-w-[1022px]` 在场且 `min-w-[1150px]` 已消失。

## 11. G-5 看板列宽与筛选结果解耦（全列常驻等分 + 空列「暂无任务」，2026-09-24 写回）

用户报障原话：**「添加任意筛选项筛选后列宽发生变化……有内容的列宽度发生变化，如果每一列都有内容不会出现」**，并自行定位到「空列没有『暂无任务』占位、撑不起列宽」。与 §10.1 是同一类病（列宽成了筛选结果的函数），但落点在看板列而非任务列表，故单开一节。

**冲突与拍板**：PRD v1.5 §4.1 与 §5 第 5 条明文规定「列内无可渲染卡片时该列折叠为 40px 竖条，筛选视图里的空列只是噪声」——照这条做就必然复现用户看到的现象。摆清冲突后**用户选择「全列常驻等分 + 暂无任务」**：取消该折叠规则，任何视图下七列恒等分，空列照常显示「暂无任务」。**该拍板覆盖 v1.5 原条款**，PRD 两处已就地改写并留原文与实测证据。

- [x] 根因唯一：`features/board/model.ts::columnCollapsed`（列内无卡 + 非默认视图 ⇒ 折叠）→ `board-column.tsx` 用 `w-column-collapsed shrink-0` 定宽 40px 并把整段列体（含 `ColumnEmpty`「暂无任务」）条件短路。修法为**修模型而非打补丁**：该函数连同 `collapsed` prop、`w-column-collapsed` 分支、列头竖条形态、`{collapsed ? null : …}` 包裹一起删除，列恒为 `min-w-[180px] flex-1`；`--container-column-collapsed`（40px）token 零消费者后一并删；随折叠存在的 `transition-[width]` 也删（`motion-spec.md` L3 的纯 CSS 位移档只授权「侧栏折叠」，看板列折叠本就不在授权表内）。
- [x] 未牵连的相邻规则：`index.tsx` 的 `total === 0 && defaultView`（**整张看板**空且未筛才用页面级空态替掉列区）行为一字未改，`defaultView` 只是不再下传给列。
- [x] **dev 已验（2026-09-24 · dev 演练环境 5196/7796，非打包 dmg）——筛选后列宽恒定**：验证动作 = 看板工具栏「筛选」→ 优先级面板点 `P3 低`（URL 成 `#/board?priority=3`），用 `getBoundingClientRect()` 量七个 `<section>`。真实窗口 1940px 档：**无筛选 7 列 × 228px** → **加 P3 后仍是 7 列 × 228px（逐像素一致）**，列行容器 clientW 1692 = 7×228 + 6×16 gap；空列由无筛选时 3 个增至 5 个，**5 个空列全部渲染出「暂无任务」**（修复前同一操作：需求池/待执行 228→**698px**、其余五列塌成 **40px 竖条且不显示「暂无任务」**）。页面级 `documentElement.scrollWidth 1940 === clientWidth 1940`，无横向溢出。
- [x] **dev 已验——三档响应式（960 / 1280 / 1600，同源 iframe 造真视口，每档各跑「无筛选」与「P3」两态）**：三档**列数恒 7、单列宽恒 180px**（筛选前后完全一致），列宽地板 7×180 + 6×16 = 1356 大于容器可用宽，故按 B7 口径走**容器内横滚兜底**——列行容器 clientW/scrollW 实测：960 档 **848 / 1356**、1280 档 **1032 / 1356**、1600 档 **1352 / 1356**；三档**页面级 `scrollWidth === clientWidth`（960/1280/1600 各自相等）零横向溢出**，横滚只在看板列行内。空列「暂无任务」在无筛选态 3 个、P3 态 5 个，逐档一致。列内竖滚（B4）未退化：需求池 `.atb-scroll` clientH 1225 < scrollH 1450、`overflow-y: auto`。console 零 error/warning。
- [x] 回归单测：新增 `features/board/__tests__/column-always-open.test.ts`（7 例，用 `renderToStaticMarkup` 真渲 `BoardColumnView`）——断言非默认视图下空列 class 含 `flex-1` + `min-w-[180px]` 且不含 `w-column-collapsed`/`shrink-0`、七个状态列逐个显示「暂无任务」、只剩一列有卡的筛选快照仍渲出 **7 个列容器 + 6 个空态**（七列数量不随筛选减少）、全空快照仍 7 列 7 个空态；既有的 `columnCollapsed` 断言用例为零（无既有用例需删）。
- [ ] **待 beta 包复验**（本条 dev 已验，复验看的是打包环境）：①macOS **经典（占位）滚动条**会挤掉容器宽，需在 dmg 里确认三档仍是 7 列等分、且横滚不泄漏到页面级；②Tauri WebView 下最小窗 960px 档列行横滚可拖可滚（触控板与滚动条两种手势）；③深色主题下空列虚线框与「暂无任务」可读性。
- 相邻面刻意未动：`docs/Agent Task Board 高保真原型 v1.1.md` §3.1/§3.4（366、623 行）与 `docs/v0.0.4/回归验收矩阵.md` §7.3 记录行仍写着折叠 40px——前者是**已定版的原型历史稿**、后者是**G-5 之前的实测留档**，均不回改；权威口径以 PRD v1.5 §4.1/§5 改后条款 + 本节为准。折叠的另外两个同名概念未碰：主导航折叠（`atb.nav.collapsed`，motion-spec L3 授权项）、任务列表分节折叠。

**本节门禁**：web `npx tsc --noEmit` 干净、`npx vitest run` **14 files / 126 tests 全绿**（基线 13/119 + 本节新增 7 例，零删零 skip 零放宽期望）、`npm run build` 成功；产物 CSS 内 `column-collapsed` 类与 40px 定档已消失。本片未触碰 `apps/api` 源码，api 门禁不适用。

## 12. 0925 批：编码技能收录 31 条 + 技能分类两级树化（2026-09-25 写回）

用户令「依据 docs/0925/index.md 整理的编码技能按最新技能维护方式录入，标签需补产研阶段」+「技能库需要考虑二级分类，比如编码相关的全部放到二级方便查找」。拍板链：内置 seed 管线 + 抓 GitHub 官方 SKILL.md 原文；词表整体改两层树、125 条全量归类；阶段词双角色（category 叶子 + tags 保留，卡片同名两行是明示接受的特例）；Q1-A/Q2-B/Q3-B/Q4-A/Q5-A+D 逐题拍板。设计依据与 125 行映射表：`docs/0925/二级分类草案.md`；口径写回 PRD §9.2/§15.1/条款 82/§21.6。

- [x] **收录面 dev 已验**（c6 走查环境 /tmp 副本 + 7796/5196）：默认技能 total=125（93 千问 + 31 coding + code-review 样例），31 条 coding 卡片为分类徽标（阶段叶子）+ 阶段标签两行，千问 93 条 tags 恒空；三处诚实改名（deprecation-and-migration/devops-code-review/addyosmani-test-driven-development）在库可见、`source.renamedFrom` 留档目录。
- [x] **树化 schema（增量与 fresh 双路径）**：0018 整表重建 CHECK（`''` + 16 叶子；Q4 直映射「质量保障→质量与安全」在 INSERT SELECT CASE 内，先 UPDATE 会撞旧 0017 CHECK）、0019 逐 id 归位 35 内置行；/tmp 真增量演练（0017 水位插桩）与 fresh 重放 0001→0019 终值一致；新 CHECK 拒收「质量保障」「编码开发」实炸验证过；`skill_versions` CASCADE 复验过。
- [x] **两级筛选栏真机走查**：一级行 7+未分类、计数含子树（41/25/12/9/13/17/11+0=128，含 3 条走查遗留用户行）；点「编码开发」展二级行（需求与规划 8/开发与实现 4/质量与安全 10/代码清理 6/运维与协作 5/测试自动化 2/开发编程 6）、选一级=收拢全选子叶、在全选子叶下点某叶子=「除它以外全部子叶」、计数 0 置灰不消失；原生 button 可键盘操作。
- [x] **搜索命中面（含走查抓出的补口）**：库页服务端 keyword 命中面拼入 `parentOfCategory`（`3dd8f37`）——搜「编码」41 条、复用 placeholder 承诺；SkillPicker（复制现有技能弹窗实测）搜「编码」收拢编码开发子树；搜「未分类」恒 0 条（'' 不进命中面）；`GET /skills` 仍无 `category=` 参数（客户端筛选不变）。
- [x] **改判落库可见**：prd/prd-generator/brainstorming 徽标=需求与规划（Q3-B）；devops-code-review 徽标=质量与安全而标签仍「运维与协作」（Q2-B category/tags 解耦）；codexqa-defect-analyzer 双阶段标签存活。
- [x] **编辑器/写入面**：编辑器分类两级 16+1 单选、纯分组一级只作 aria-hidden 组头不可提交；create/patch/MCP `update_skill` 越表（含三纯分组一级与作废词）422 两级回显；SKILL.md 导入词表外（含「质量保障」）归 `''` 不报错（Q5-D，无 compat）。
- [ ] **待 beta 包复验**（dev 环境等价、包内首启路径不同）：①真库 `~/.agent-board`（停 0006）首启直跳 0019 后 §3 的树化核验 SQL 全过（本批是增量最大的一次，0015~0019 四棒连跑）；②125 条内置随包 seed 首启 upsert 收敛、技能库页「125+用户行」计数正确；③包内 WKWebView 下两级筛选栏两行 chip 在 960px 最小档不折行溢出；④`get_vocabulary` 的 tree 字段在真实 MCP 客户端回显两级词表。

**本节门禁**：api 689 用例 / tsc 0 / boot:smoke PASS（fresh total=125）；web 179 用例 / tsc 0；两侧镜像四导出（树/叶子/阶段词/作废词）逐字守护测试在 web `skill-categories.test.ts`。

## 记录区（现象/截图/报错贴这里）

| 项 | 结果（过/挂） | 现象备注 |
|---|---|---|
| §1 条款 1 | | |
| §2 条款 4 | | |
| §3 条款 68 | | |
| §4 §20.3-8 | | |
| §5 #46 唤醒词 | | |
| §6.1 B1 包名切换 | | |
| §6.2 B2/B2b 状态可见性 | 过（2026-09-24 R-A · dev 演练环境，非打包 dmg） | 三项均按真实 claim/stop 造数验过：chip「执行中 N · 最近活动…」随 WS 实时 +1、无进度数据时占位条在、RUNNING=0 且 24h 无活动整条隐藏（含 2h 对照证明是规则生效非请求挂）。**发现并修 1 缺陷**：Agent 刚 claim 的瞬间「最近活动」退化成绝对时间，30s 后自愈——根因 `formatRelative` 把几秒级负 delta 当未来时间，`96f7fb7` 修（60s 时钟抖动容差 + 3 单测）。 |
| §6.3 B3/B4/B5/B7 交互 | 过（R-A · dev） | 分类筛选平铺多选 OR（13 chip 计数与卡片数吻合）、列内竖滚 + 列底「还有 N 条」（把 `board_column_limit` 调到下限 10 造超限后还原）、列最小 180px 整行横滚兜底、960px 七列等分铺满不压字。分组过滤复位入口的验条文案已按实测更正（见 §7.3）。 |
| §6.4 动效 v1.2 | 过（2026-09-24 R-B · dev 演练环境，非打包 dmg，六项全过） | 全部按 WAAPI 逐帧采样而非肉眼：微交互 computed `0.14s + cubic-bezier(0.2,0,0,1)`、`duration-120` 全仓归零（87 处 140）；抽屉退场 遮罩 140ms/面板 180ms、通知中心 0.97→0.00 约 210ms **退完才卸载**、搜索下拉 100ms，与 spec §1.L2 表逐条对齐；450px 矮窗（同源 iframe 956×446）新建任务 Dialog 页级零溢出 + `.atb-scroll` 456>289 可滚 + 按钮 bottom 406≤446 可达，同尺寸看板列内滚未退化成整页滚；⌘K 入场 140ms/↓ 改 active/Enter 开抽屉/Esc 逐层；技能库首屏 stagger delay 集合恰 {0,40,…,240}，WS 新卡只动那一张；三档换肤即时互切零横向破版、验完复原跟随系统。**1 处偏差已裁定（2026-09-24）**：新卡入场取 `itemVariants` 240ms、spec §168 原写 200ms → 改规范跟实现，motion-spec §5-1/§5.2 已改 240ms 并记裁定、代码不动。**审核表单矮窗由 R-C-2 补量完毕**（页级 446−446=0 / `.atb-scroll` 1077>289 可滚 / 「提交审核」bottom 406≤446 可达 / B8 标注矮窗无裁切），原「未单独量」口子已封。仍**未逐帧分辨**：tooltip/menu/popover 退场、layoutId 换列飞行。 |
| §6.5 B6 MCP 词表 | 过（2026-09-24 R-C-1 · dev，协议层真机） | 对 `/mcp` 无状态 Streamable HTTP 真发 JSON-RPC（Bearer agent token）：`tools/list` 26 工具含 `get_vocabulary`，`tools/call` 一次返回全词表（五类型/四优先级档/三确认模式/七状态 + transitions 全表/artifact 词表与 uri_rule/log_level/breakdown 状态）。错值回显：REST 422 带「可选：需求 / 缺陷 / 子任务 / 巡检 / 重构」，`transition` 错值 422 直列七状态，MCP 侧 `isError:true` 且 text 通道有完整 422 体。**查出 2 处回显折损**：structuredContent 丢 details（本轮修，追加式不破坏 §12 契约）；`priority:9` 被 MCP SDK schema 先挡（-32602）走不到 B6 hint，只记档不改。**未测**：Qoder 客户端 UI 里的工具列表可见性（随 §5 合跑补一眼）。 |
| §7.1 B8/B8s 审核产物 | 过（2026-09-24 R-C-1 协议腿 + R-C-2 UI 腿 · dev） | ①UI：T-1020（当前 R-2007 零产物、R-2006 有 1 产物）从看板抽屉与审核页两个入口开审核弹窗，均锚定「R-2007 / 第 2 次执行」，产物区不空白并给出归属标注「本次执行没有回传产物；以下为该任务最近一次有产物的执行（第 1 次 · R-2006）」，`r-c1-run1.txt / 24 B` 可预览（内容取回）可下载（GET 无报错）；反证空态未触发。②Agent：当前 run 上传 201、旧 run 上传 **409 TASK_NOT_RUNNING**、run 不属该任务 404、complete 引用未上传 uri 422 `not_uploaded`、UI token 打上传口 403、**complete 引用旧 run 已上传 uri → 200** 且产物行未被改写。**查出并修 1 处文案排版**：归属标注实机渲染「第1 次」缺空格（JSX 折行），`e27d26e` 加 `{' '}`。**记档不改（已拍板）**：守卫按 run 不按 token、且不校验任务状态（REVIEW 后仍可上传）——B8s 意图止于「别挂到过期 run」。**另核掉一条早先误判**：上传 uri 由服务端自造，「跨 run 同 uri 被静默去重」在当前模型不成立。 |
| §7.2 B9/B10/B11 设置与托盘 | 前二过（2026-09-24 R-C-2 · dev），托盘项只能真机 | B9：设置侧栏 MCP Tab 紧随 Token（顺序 通用/视图/Token/MCP/字段定义/模板/数据/日志与审计/备份/关于），Token 页已无唤醒模式字样、该 RadioGroup 在 MCP 页；single→continuous 落库后刷新与深链 `?tab=mcp` 均保持，验完还原 single（审计两条留痕）；**「重启 app 后仍在」dev 测不了，随 §5 在 beta 包复验**。B10：14 次 Tab 切换（覆盖 10 页）后 nav/header 仍是同一 DOM 节点对象、dataset 标记未丢，document 类资源条目 0→0（无整页 reload），内容替换 18–46ms（1–3 帧）无白屏帧，console/onerror 全清；逐 Tab 无白屏页、无不可达按钮。B11 托盘深色可见：需打包 dmg + macOS 菜单栏，dev 无桌面壳，**未测**。 |
| §7.3 B12→B15 统一过滤 | 过（2026-09-24 R-D · dev，七项全过） | 六维弹层维内 OR/维间 AND、chip 逐条 × 与「清除全部」、URL `#/board?…` 同步 + 刷新不丢 + 全新 profile（headless）从 URL 完整还原、v1 槽 + 旧 `board.grouping` 一次性迁移三维并存（这条同时是 B15-④ 水合竞态修复的真机路径背书，此前只有单测）、已清空的旧分组不复活、看板/列表/流程图三视图共用过滤态、空列折叠 40px 竖条、960px 工具栏折行不压字、列表页「分组方式」独立偏好互不干扰。唯一文案不符处（视图段「全部」被写成一键回全量）已在 `7b933ee` 更正验条。**另记**：视图段「全部」确实不清过滤，属设计内正交两轴。 |
| §7.4 B13/B14 与 dnd | 过（2026-09-24 R-E · dev，三腿全过） | ①`#/tasks` 全新加载 console 无 validateDOMNesting（thead/tr）；②导航折叠三态在 767px 真窗口全验（无偏好→自动收 64px、`pref='0'`→恒 200px 且刷新后仍在、`pref='1'`→64px、清偏好→回自动），按钮实际文案「折叠导航」已更正验条；③合成 Pointer 序列拖 T-1010 需求池→待执行→拖回，两列归属 1.2s 内互换、`GET /tasks` 回 `READY`/`BACKLOG`（落库）、全程 console 无新报错。**同轮发现并修掉 1 条挂账**：board/tasks 纯挂载各 3 条 forwardRef error（#23，`9777249`，根因=直写在 forceMount Portal 里的 AnimatePresence 无 forwardRef，退路是同 popover 形状；修后挂载归零、通知中心退场 WAAPI 采样 0.97→0.00 约 210ms 后卸载）。残留：layoutId 换列飞行动效只测到「拖拽期间有动画在跑」，未逐帧分辨 layoutId，归 §6.4（R-B）一并看 |
| §9.1 技能分类一套标准 | | |
| §9.2 技能选择器四处统一 | | |
| §10.1 G-1 任务列表列宽 | 过（2026-09-24 · dev 真机浏览器，非打包 dmg） | 根因=auto 布局按可见行内容重算列宽（过滤/分节行/滚动条三放大器）。修模：`Table` 加 `columns`→`table-layout:fixed`+`<colgroup>`，列宽唯一真值 `task-list/columns.ts`。真机三档 × 四形态复验：11 列像素恒定 [40,80,228,72,78,96,112,112,64,96,52]、表头全 44px 无折行无截断、20 行×11 格零内容溢出邻列、1800 档标题独吞 640。**中途查出并收掉一条自己的回归**：首版地板 1150 让 1280 档出现修复前没有的容器内横滚（容器=视口−250=1030，旧 auto 实测恰好塞满 1030 不滚）→ 地板收到 1022，1280 实测 `scrollW==clientW==1030` 零横滚、960 档页面零横向溢出。待包：经典占位滚动条挤掉 15px 后 1280 是否仍不滚（余量仅 8px）。 |
| §10.2 G-2 `update_task` | 协议层过（2026-09-24 · dev，InMemoryTransport 全链路 17 用例），客户端实调待包 | MCP 工具 26→27。守卫三支（拍板）：RUNNING 须持当前租约（与 `update_progress` 同 `leases.verify` 口径）、BACKLOG/READY 免租约、其余四状态拒 409 `TASK_NOT_EDITABLE` 且 details 指名该走的链路。字段面逐字取 `taskPatchSchema.shape`（13 可写字段），校验/审计只有 `TasksService.applyPatch` 一份；**REST `PATCH /tasks/:id` 的 RUNNING 即拒一字未动**（既有测试 + 新增红线用例双向锁住）；`status`/`assignee` 不在可写键内，改不到状态机与执行权。 |
| §10.3 G-3 `update_skill` | 协议层过（同上，16 用例），客户端实调待包 | 27→28。可写面 = UI `skillPatchSchema` 除 `status` 外全部；`status` **有意排除**（UI 发布=`POST /versions` 快照 + `PATCH {status}` 两步，agent 面无快照工具，只改状态会让 `current_version` 与 content 脱节），`mcp_dependencies` 与 UI PATCH 面一致不可写。守卫全复用 `SkillsService.patch`（默认技能 `SKILL_READONLY`、子技能自引用/成环 `SKILL_REF_SELF`/`SKILL_REF_CYCLE`），`@AuthScope('ui')` 未摘。词表回显补在 agent 入口层：`parseToolInput` details 追加 `received`、hint 拼「可接受值 + 当前收到」，`get_vocabulary` 新增 `skill_categories`；REST 的裸 zod 422 形状 UI 在用、锁进测试未改。 |
| §11 G-5 看板列宽 | 过（2026-09-24 · dev 真机浏览器，非打包 dmg），打包环境待复验 | 用户拍板「全列常驻等分 + 暂无任务」，覆盖 PRD v1.5 §4.1/§5 的「空列折叠为 40px 竖条」。修法删概念：`model.ts::columnCollapsed` 连函数删除、`board-column.tsx` 的 `collapsed` prop/`w-column-collapsed` 分支/列头竖条形态/条件包裹全清、40px 定档 token 与随之失去对象的 `transition-[width]` 一并删；`total === 0 && defaultView` 那条整页空态规则未动。实测：1940px 真窗口无筛选 7×228 → 加 `P3 低` 后仍 7×228（修复前 698/698/40×5 且空列无「暂无任务」），5 个空列全部显示「暂无任务」；960/1280/1600 三档（同源 iframe 真视口，各跑无筛选与 P3 两态）列数恒 7、单列恒 180px、容器 clientW/scrollW = 848/1356、1032/1356、1352/1356（横滚只在列行内）、三档页面级 `scrollWidth === clientWidth` 零横向溢出；B4 列内竖滚未退化（需求池 clientH 1225 < scrollH 1450）。新增 7 例单测（`renderToStaticMarkup` 真渲列组件）。 |

另记：**React Flow 归属水印**——流程图视图原先 `proOptions={{ hideAttribution: true }}`，控制台明确提示隐藏需订阅 Pro（本项目无订阅）。2026-09-24 拍板「恢复显示」，已随 `e27d26e` 改回 `hideAttribution: false`（与技能画布既有写法同风格），水印走 `globals.css` 既有的弱化配色（透明底 + `--color-text-tertiary`，深浅主题同一令牌），未加隐藏、未改色位。beta 包复验时确认深浅两套主题下不压内容即可。
