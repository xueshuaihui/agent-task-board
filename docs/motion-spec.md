# Jarvis Workbench — 系统动效与交互规范（Motion Spec v1.2）

> **本文件是动效与交互层的唯一权威规范**，自 2026-09-23 起生效：
> - 覆盖并取代 DESIGN.md §1.6 / §2（动效相关段落）/ §3（页面过渡、指示器）/ §5（通用动效片段）；DESIGN.md 相应章节收敛为指向本文的引用。
> - 覆盖并取代《高保真原型 v1.1》§1.6 动效时长表（其"抽屉 240ms / 弹窗 160ms"等数值作废）。
> - 未被本文覆盖的交互逻辑、字段语义、信息架构仍以原型 v1.1 与 DESIGN.md 为准。
>
> 改 token 落点：CSS 侧只改 `src/styles/globals.css`，JS 侧只改 `src/lib/motion.ts`，且必须与本文同步。
>
> v1.1 变更：评审后修订——时长允许值改为引用分层表；补页面退场/Swimlane 失实修正；
> 看板卡换列定为 layoutId 跨列飞行；新增 §8 交互规约（焦点/反馈判定/Loading/禁用态）；总账补行。
> v1.2 变更（二轮实测）：浮层退场现状核假（drawer/menu/遮罩退场未缩短，转 P0 任务）；
> drawer 退场 200→180ms 以自守「≤入场×0.7」；纯 opacity 淡变曲线认 easeOut；
> spinner 认现状 Tailwind animate-spin 1s；reduced-motion 残余口径放宽为「纯 opacity、时长随浮层档」；
> §5.2 回落规则 5 扩展到「刚释放的拖拽源（同帧）」。
> 落地注记（§9 P0/P1 实现后回填，未升版本号）：§1-L2 曲线列口径澄清（exit 位移类走 exit/drawerOut 档）；
> §4.6 补 sonner 机制豁免（height 收拢/stack 缩放保留内置值）与退场两个边缘态偏差记录；
> §5.2 补触发面注记（飞行限用户发起 direct 换列，WS 重取换列设回落规则 6；泳道整体不参与；scale 1.02 划掉）；
> 浮层退场可播的前提是**消费者侧受控 open**：components/ui 挂 AnimatePresence 只解决一半，
> features 侧 `if (!target) return null` 式条件卸载会让 open 永远没有 true→false 过渡帧（退场被整段跳过）。
> 统一套路=ref 保留末次非空目标 + `open={Boolean(target)}` + 重开以 session key 重挂复位（19 个消费者已收口）。

---

## 1. 动效分层模型（Motion Layers）

全部动效归入四类。任何一处动画先确定属于哪一层，再查 §2 映射表取参，**不允许自造时长/缓动组合**。
**时长与缓动的允许值以本节各层表格列出的为全集**（含循环档），表外值一律禁止（见 §9）。

### L1 · Micro（微交互）— "手感"

- **范围**：hover、按压（active）、focus ring 出现、按钮 loading 起停、菜单项行高亮、输入框描边、行内操作浮现（opacity）。
- **语言**：仅改颜色/阴影/位移 ≤2px/透明度的小变化；一律 CSS transition，不走 motion JS。
- **参数**：`140ms / ease-settle`。
  **现状偏差（P0 并档）**：代码中 20+ 处 `duration-120 ease-out`（散布 ui/input、select、table、switch、tabs、sidebar、notification-center、task-detail 产物行、global-search 行、filter chip 等），全部并到 `duration-140` 并把曲线换成 `ease-settle`（裁决：规范为准，一次改齐）。
- **原则**：微交互不占用"同屏 ≤1 组编排动画"预算（它不算编排）。

### L2 · Overlay（浮层）— "出现与消失"

- **范围**：Dialog、Drawer、Menu、Tooltip、Popover（筛选面板）、通知中心面板、全局搜索下拉、Toast。
- **语言**：入场 = 淡入 + 来源方向的轻微位移/缩放；退场 = 同轨迹反向但**更快**；遮罩独立淡入淡出。统一由 ui 封装内的 motion + AnimatePresence 实现，业务侧不重复写。
- **参数**：

  | 场景 | 入场 | 退场 | 曲线 |
  | --- | --- | --- | --- |
  | Dialog | 200ms：scale .96→1 + y 8→0 + 淡入 | 140ms：反向 | `ease-emphasis` |
  | Drawer / 通知中心 | 260ms：x 100%→0（通知中心 `-100%→0`） | 180ms（现状 exit 仍复用 260ms，P0 缩短） | `ease-emphasis` |
  | Menu / Popover / 搜索下拉 | 140ms：scale .97→1 + 淡入 | 100ms 纯淡出（现状 140ms，P0 换 `menu` 档） | `easeOut` |
  | Tooltip | 120ms：淡入 + y 4→0 | 100ms 淡出 | `easeOut` |
  | Toast | 200ms：y -8→0 + 淡入 | 140ms 淡出 | `ease-emphasis`（实现走 §4.6） |

  **曲线豁免**：纯 opacity 淡变（无位移/缩放分量）允许 `easeOut` 代替 `ease-settle`（曲线为准的裁决对 L1 位移类过渡仍然全部换 settle）。遮罩（overlay）出入统一 200/140ms；现状退场复用入场 200ms，P0 补 `exit: transitions.exit`。**曲线列辖入场**：位移/缩放类退场曲线的正典是 §3.2 `exit` 档（easeOut）与 `drawerOut` 档（emphasis），实现按档位取，不再另判。

- **原则**：退场必须比入场快——大浮层（Dialog/Drawer/Toast）退场 ≤ 入场×0.7；中小浮层（Menu/Popover）至少缩短 40ms；≤140ms 的微型浮层（Tooltip）出入差 ≥ 20ms 即可。用户按 Esc/点击遮罩关闭时不得有可感知滞留。

### L3 · Layout（布局与编排）— "东西如何各就各位"

- **范围**：页面过渡、激活指示器滑动（layoutId）、列表/网格入场、卡片换列飞行、拖拽与落位、Tab 内容切换、侧栏折叠、泳道展开。
- **语言与参数**：

  | 场景 | 实现 | 参数 |
  | --- | --- | --- |
  | 页面过渡 | AnimatePresence `mode="wait"` + PageTransition | 入场：淡入 + y 6→0，240ms `rise`；**退场：淡出 140ms（当前代码无 exit，P0 补齐）**；总时长 ≈380ms，>400ms 视为 bug |
  | 激活指示器 | motion `layoutId` + `springs.gentle` | Sidebar 左缘 3px 竖条（`nav-active-bar`）、设置页分区胶囊、Tabs 胶囊/下划线 |
  | 列表入场 | `listVariants`（stagger 40ms）+ `itemVariants`（y 8→0 + 淡入） | 子项延迟上限 240ms；首屏数据异步到达时子项必须自带 initial/animate（防卡 hidden，motion.ts 既有约定） |
  | 列表项移除 | exit：opacity→0 + y 8 | 140ms；让位挤压由 layout 默认承担 |
  | **卡片换列（状态变更）** | motion `layoutId` 跨列共享元素飞行（细则见 §5.2） | `springs.gentle`，总时长 ≤260ms |
  | 拖拽 | dnd-kit DragOverlay：rotate 2° + `shadow-card-drag`；原位置虚线占位 opacity .6 | 落位 dropAnimation 160ms `ease-settle`；吸附语义强处用 `springs.snappy` |
  | 队列/卡片切换 | motion `layout` | `springs.gentle` |
  | 侧栏折叠 | CSS `transition-[width] 200ms ease-settle` | L3 中唯一允许纯 CSS 的位移档（现状即合规） |
  | 泳道展开/收起 | **现状无动画（瞬时）**；可选补 `height 200ms ease-settle`（P2 可选，用 grid-rows/测量法） | — |

- **原则**：同屏同时运行的 L3 编排 ≤ 1 组；stagger 间隔 ≤ 40ms、单元素 ≤ 300ms；**滚动、数据轮询刷新、文本内容变化永不做动画**。

### L4 · State（状态反馈）— "告诉你发生了什么"

- **范围**：状态变更高亮、进度、角标数字、骨架屏、复制成功等瞬时确认。
- **参数**：

  | 场景 | 实现 | 时长 |
  | --- | --- | --- |
  | 状态六态变更高亮 | `animate-status-flash`（CSS keyframes，三段底色） | 800ms |
  | 执行中进度条 | `--animate-flow` 流动高光 | 1.6s linear infinite |
  | 骨架屏 | `--animate-shimmer` | 1.4s infinite |
  | 按钮/局部 loading | Tailwind `animate-spin`（Loader2 现状即准） | 1s linear infinite，不自造 keyframes |
  | 数字徽标变化 | key={value} + scale .6→1 | `springs.pop` |
  | 勾选/开关指示 | Indicator scale 0→1 `springs.pop`；Switch 滑块 `springs.snappy` | 弹簧自然收敛 |

- **原则**：状态反馈必须是"一次性"或"循环进行中"，不得引入布局跳动；flash 只动背景色，不动位置。

---

## 2. 组件 × 动效映射表（总账）

| 对象 | 层 | 关键参数 | 现状 |
| --- | --- | --- | --- |
| Button hover/按压 | L1 | 140ms/ease-settle + active:scale .98 | ⚠️ 散点 120/ease-out，P0 并档 |
| 菜单项/侧栏项/表格行/输入框/产物行浮现 hover | L1 | 140ms/ease-settle | ⚠️ 现为 120 ease-out，P0 并档 |
| 看板卡 hover | L1 | -2px 抬升 + shadow-card-hover + 140ms | ❌ 缺抬升，P0 补 |
| Dialog / Drawer / Menu / Tooltip | L2 | §1.L2 表 | ⚠️ 入场合规；退场未缩短（drawer/menu exit 复用入场时长与档）、menu 档未落地，P0 |
| 全局搜索下拉 | L2 | Menu 同款：scale .97 + 140/100ms | ❌ 零动画，P1 |
| 通知中心（面板侧滑 + 列表行 hover） | L2/L1 | drawer 260ms；行 hover 并档 | ⚠️ |
| Toast | L2 | §4.6 | ❌ 未收口，P1 |
| 页面过渡 | L3 | 240ms rise + **140ms 退场** | ⚠️ 退场缺失，P0 补 |
| Sidebar 激活竖条 | L3 | layoutId `nav-active-bar` + gentle | ✅ |
| Sidebar 折叠 width | L3 | 200ms CSS | ✅ |
| 看板列 stagger / 退场 | L3 | listVariants + 140ms exit | ✅ |
| 拖拽 overlay/落位 | L3 | rotate 2° + 160ms settle | ✅ |
| **看板卡换列飞行** | L3 | layoutId + gentle ≤260ms | ✅ 已落地（触发面与回落细则 §5.2） |
| 批量操作条 | L3 | y 16 滑入 + scale .97 | ✅ |
| 审核队列切换 | L3 | layout + gentle | ✅ |
| 任务详情 Tab 内容切换 | L3 | AnimatePresence wait 淡入 | ✅ |
| skills / requirements / dependencies 列表 | L3 | listVariants 首屏入场 | ❌ 无，P1 |
| 泳道展开收起 | L3 | 现状瞬时；补则 200ms | ⚠️（P2 可选） |
| groups / creation / breakdown（overlay、draft-card、undo-stack 等） | L2/L3 | 归入对应层语言，走查销分 | ✅（P2 对照走查） |
| status flash / progress / skeleton / 徽标 | L4 | §1.L4 表 | ✅ |
| flow 画布 / 依赖图 | — | §6 专项：显式近零动画 | ✅（约定为不做） |
| Switch / Checkbox / RadioGroup | L4 | pop/snappy | ✅ |

（✅ 已合规 · ⚠️ 部分合规/待并档 · ❌ 待补，任务见 §9）

---

## 3. Token 定稿

### 3.1 CSS 侧（globals.css）

- 缓动保留两档，不扩：`--ease-settle: cubic-bezier(.2,0,0,1)`、`--ease-emphasis: cubic-bezier(.32,.72,0,1)`。
- L4 专用 keyframes 保留：`status-flash / shimmer / flow`；spinner 以现状 Tailwind `animate-spin`（1s，全仓 Loader2 统一）为正典，不自造。
- **删除死代码**：`--animate-drawer-in / --animate-dialog-in / --animate-pop-in` 三个组合 token 及其 keyframes（浮层动画已全部走 motion JS，双轨只留 JS 一轨）。
- 时长不设 `--duration-*` 变量（Tailwind v4 `duration-140` 裸值直写），但**L1 层允许值只有 140ms 一个**。
- 全局 `:focus-visible` ring 现状收录为正典（globals.css:292-295）：`2px solid primary-ring、offset 1px、无过渡`，见 §8.1。

### 3.2 JS 侧（lib/motion.ts）

```ts
springs   = { gentle, snappy, pop }          // 数值不变
transitions = {
  fade:    { duration: .14, ease: easeOut }, // 存量档，P0 并档后 ease 改 settle 或并入 exit
  menu:    { duration: .1 },                 // 新增（P0）：小浮层退场
  overlay: { duration: .2,  ease: emphasis },// L2 弹窗入
  drawer:  { duration: .26, ease: emphasis },// L2 抽屉/面板入
  drawerOut: { duration: .18, ease: emphasis }, // 新增（P0）：抽屉/通知中心退场
  rise:    { duration: .24, ease: emphasis },// L3 页面/列表入
  exit:    { duration: .14, ease: easeOut }, // 统一定义档（P0）：列表移除/页面退场/toast 退场
}
listVariants / itemVariants                  // 现有实现即为准（含 custom-index 延迟上限 .24 与防卡 hidden 约定）
```

档位定义即本表，先入 motion.ts 后使用；实现排期在 §9。

---

## 4. 浮层统一语言细则

1. 所有浮层必须经 `components/ui/*` 封装（Radix 行为 + motion 动画），**禁止业务自绘 `position:absolute` 无动画面板**。
2. 出入场方向暗示来源：Menu/Tooltip 从触发点轴向轻微缩放/上浮；Dialog 居中缩放；Drawer/通知中心从屏幕缘滑入；Toast 从顶部下滑。
3. `AnimatePresence` 必须配 `forceMount`（Radix 场景沿用 dialog.tsx 现有写法），保证退场可播放。
4. 遮罩统一 `bg-black/45`（深色 `/60`）+ `backdrop-blur-[2px]`，淡入随面板、淡出 140ms。
5. 同时刻最多一个 modal 级浮层；二级浮层只允许确认 Dialog 与 Tooltip。
6. **Toast 收口**：仍在 `ui/toast.tsx` 内配置 sonner（业务只走 `useToast()`）；规格定死为——位置顶部居中；入场 y -8→0 + 淡入 200ms、退场淡出 140ms（sonner 原生 transition 覆盖不了的部分用封装内 CSS keyframes 实现，不得泄漏到业务层）；停留时长 2.4s/4s/6s（success/info/warning/error）现状不变。
   **sonner 机制豁免（落地注记）**：栈展开/收起的 `height 400ms`、`box-shadow 200ms`、非最前卡的堆叠收拢缩放属 sonner 高度重排机制内置值，不入 §1 允许值集合校验；两个边缘态维持 sonner 默认、记录在案——①展开态移除最前卡仍走飞离 transform，②折叠态非最前卡移除走 sonner 内置 `.5s/.2s`（CSS 分值更高，覆写需 `!important`，收益不抵侵入性）。

---

## 5. 编排与中断规则

1. 列表入场只在**首次挂载/视图切换**播放；WS 增量推送的新项只对该项做单项 200ms 淡入（不重放 stagger）。
2. 用户操作（点击/拖拽）到达时进行中的 L3 动画可被打断：使用 motion 默认中断行为，不加"播完再响应"逻辑。
3. 页面过渡 `mode="wait"`：旧页退场 140ms + 新页入场 240ms（P0 补 exit）。
4. 禁止用动画做加载兜底（转圈之外）；数据为空走 EmptyState，无入场动画要求。

### 5.1 WS 增量与乐观更新

- 乐观更新 = 立即播放对应动画（换列/增删），服务端确认**不再重放动画**；仅失败回滚时允许反向动画一次。
- 同一 taskId 的连续状态变更（如 running→review 快速连发）合并：飞行中的卡被打断后飞向新目标，不排队。

### 5.2 看板卡跨列飞行（换列动画）

- **实现**：卡片根元素挂 `layoutId={task.id}`，跨列时由共享元素过渡完成飞行；`springs.gentle`，总时长 ≤260ms；飞行中卡片带 `shadow-card`（不起 2° 倾斜——倾斜是拖拽专属语言）。
- **触发面（落地注记，§9-P1-10）**：本项目无本地乐观更新，换列一律来自快照异步重取，旧列 exit 的抑止只有「用户动作发起 → 快照回传」这段 pending 期一个可靠窗口。因此飞行只覆盖**用户发起的 direct 换列**（菜单移动到/行内移列/键盘 ←→，发起同帧登记 pending-mark）；**WS/轮询重取驱动的换列**旧列最后一次渲染已把 140ms exit 定死，再挂 layoutId 会双画面，按方案 B 处理（视同回落规则 6）。同帧竞态由 `layoutId` 命名空间 + `LayoutGroup` 圈定六列作用域，滚动祖先挂 `layoutScroll` 尽力修正。
- **回落规则（任一命中即退化为「旧列 exit 140ms + 新列单项淡入 200ms」）**：
  1. 目标列/泳道未渲染（分组折叠、横向溢出未滚动到）；**泳道视图整体不参与飞行**（折叠泳道 display 即卸载，规则 1 常态命中）；
  2. 起止点跨滚动容器导致 layoutId 测量失效；
  3. `prefers-reduced-motion`；
  4. 同帧内换列 ≥ 4 张（批量操作/导入场景，全部走瞬时）；
  5. 该卡是当前**或刚释放的**拖拽源（释放同帧内 dnd-kit dropAnimation 已在播，禁止双动画；拖拽换位一律以落位动画为唯一语言。确认弹窗延迟到 210ms 抑制窗之后的 `actions.move` 属独立用户确认，按 direct 路径正常参与飞行）；
  6. WS/轮询重取驱动的换列（无用户动作先手窗口，见上条触发面注记）。
- **scale 1.02 划掉（落地注记）**：投影节点上叠加 scale 与 layout 测量互相干扰，实测风险大于观感收益，飞行体以 `shadow-card` 与位移本身为唯一语言。
- **验证门槛（P1 验收条件）**：双列同屏、泳道展开态、深浅主题、960px 最小宽四组合实测无鬼影/跳位，否则本片退回按回落规则实现（代码侧留 `fly-motion.ts FLY_ENABLED` 一键开关）。

---

## 6. 画布区（flow 视图 / 依赖图 / draft-graph）专项

结论：**显式近零动画**，写死为规则以防"顺手加动画"：

- 画布 pan/zoom/fitView 一律无动画（instant），平滑选项保持关闭。
- 节点入场不做 fade/scale（避免与拖拽布局互相干扰）；节点状态变化只走颜色与 L4 flash。
- 允许保留：`@xyflow` 自带的边流动（如有）、拖拽连线高亮、选中描边（L1 140ms）。

---

## 7. Reduced-motion 口径

维持现双轨制并定为强制：

- CSS：globals.css 全局 `prefers-reduced-motion` 兜底（已有）。
- JS：每个 motion 消费方 `useReducedMotion()`，模式固定为 `initial={reduced ? false : {...}}` + `transition={reduced ? { duration: 0 } : ...}`。
- reduced 下允许的残余：纯 opacity 淡变（时长随该浮层既有出入档，不要求另压缩——dialog/menu/drawer 现状实现即合此口径）；位移、缩放、旋转、stagger 禁止。
- 跨列飞行在 reduced 下不做任何残余淡变，直接瞬时切换（按 §5.2 回落且回落也置零时长）。

---

## 8. 交互规约（非动画部分）

### 8.1 焦点与键盘

- 焦点环正典：全局 `:focus-visible { outline 2px solid primary-ring; offset 1px }`（globals.css 已实现），**瞬时出现、无过渡**；ui 组件禁止自定义第二套 ring。
- Esc 层级（自顶向下逐层关，一次只关一层）：Tooltip → Menu/Popover/搜索下拉 → Dialog（含确认框）→ Drawer/通知中心。
- Tab 顺序 = DOM 顺序，禁止用动画/延时改变焦点路径；浮层打开时焦点入层、关闭时归还触发器（Radix 默认行为，封装不得覆盖）。

### 8.2 操作反馈判定表（Toast vs flash vs 内联）

| 事件 | 反馈 |
| --- | --- |
| 常规 mutation 成功（改字段/移动/置顶） | **静默生效**；状态类变更同时打 L4 `status-flash` 一次 |
| 破坏性操作成功（删除/归档/清空） | Toast（含可撤销时给出 action 槽） |
| mutation 失败 | Toast error 6s + 表单场景叠加字段内联红字；乐观更新回滚 |
| 长任务启动（执行/拆解/导入） | 按钮 loading → 转交 L4 进度语言（进度条/状态点），Toast info 只在立即返回的场景用 |
| 复制/粘贴等本地确认 | Toast success 2.4s 或不带 Toast（局部对勾即可） |

**规则**：同一事件禁止 Toast+flash 双通道重复提示；feedback 通道每种事件至多一个主通道（失败允许 Toast+内联双显）。

### 8.3 Loading 三形态选用

| 形态 | 用于 | 语言 |
| --- | --- | --- |
| Skeleton（shimmer） | 视图首次加载、列表为空待填 | 按目标布局占位，≤3 行 |
| Button spinner | 局部操作进行中（保存/审核/生成） | 按钮转圈 + 禁按压，宽度不跳 |
| 浮层保持 | Dialog/Drawer 提交中 | 面板不关、按钮 loading，成功后关闭；禁止全屏遮罩 spinner |

数据后台 refetch（WS 驱动的列表刷新）不出现任何 loading 形态，直接换内容。

### 8.4 禁用态

- `disabled`：`opacity .5 + cursor-not-allowed`，进入/退出走 L1 140ms；按压无 scale。
- 只读字段不加禁用底，用 `text-secondary` 区分。

---

## 9. 落地任务分解（设计已完成，本文不含代码变更）

**P0 · 对齐修正（小步，纯视觉/低险）**

1. 全局微交互并档：20+ 处 `duration-120 ease-out` → `duration-140 ease-settle`（含 task-detail 产物行浮现）。
2. 看板卡 hover 补 `-translate-y-0.5` + `transition-[transform,box-shadow,border-color]`（task-card-view.tsx:107）。
3. PageTransition 补 exit：淡出 140ms（`transitions.exit`）。
4. motion.ts 落地 `exit/menu` 档与注释指向本文；globals.css 删除死 keyframes（drawer-in/dialog-in/pop-in）。
5. **浮层退场收口（v1.2 新增）**：Drawer/通知中心面板 exit 换 `transitions.drawerOut`（180ms）、Menu exit 换 `menu`（100ms）、Dialog/Drawer 遮罩 exit 换 `transitions.exit`（140ms）——三处现状均复用入场时长。
6. DESIGN.md §1.6/§3/§5 收敛为指向本文的引用；`nav-pill` 表述修正（本轮已完成，验收时核对）。

**P1 · 空白区补齐（含风险件，单独一片）**

7. 全局搜索下拉迁入 Menu 浮层语言（140/100ms）。
8. skills、requirements、dependencies 列表首屏 stagger + hover 并档。
9. Toast 按 §4.6 收口 sonner 配置。
10. **看板卡跨列飞行（layoutId）+ §5.2 回落规则**——验收门槛见 §5.2，不达门槛退回淡出+淡入。

**P2 · 走查与巩固**

11. 深浅双主题 × 全页面动效观感真机走查（含 groups/creation/breakdown 存量对照 §2 销分），承接技术方案 L76 未了事项。
12. 窄窗口（960px 最小宽）复查 stagger/浮层定位/飞行回落。
13. 可选：泳道展开补 height transition（验证 grid-rows 方案后再定）。

每片完成过 `npm run typecheck -w @atb/web`；P0/P1/P2 内各任务独立提交，可分批验收。

---

## 10. 禁止事项（汇总）

- 禁止硬编码 hex、自造 cubic-bezier；**时长/缓动允许值 = §1 四层表格 + §3 token 表所列全集**，表外即禁。
- 禁止给滚动、数据刷新、文本变化加动画。
- 禁止业务代码直接 import Radix/motion 做浮层（只经 `ui/*`）。
- 禁止在画布区加 §6 未列出的动画。
- 禁止"等动画播完再响应操作"。
- 禁止卡片换列与拖拽 overlay 双动画并存（§5.2 回落规则 5）。
