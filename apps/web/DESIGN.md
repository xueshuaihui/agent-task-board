# Agent Task Board — UI 重设计契约（DESIGN.md）

> **本文件是 2026-09 UI 全面改版的唯一设计契约。** 所有页面/组件的视觉与动效实现必须遵守这里列出的
> token、组件 API 与动效规范。《高保真原型 v1.1》中被本文件覆盖的条目（色板、圆角、阴影、动效时长）
> 以本文件为准；未被覆盖的条目（信息架构、交互逻辑、字段语义）仍然有效。
>
> 改 token 只改 `src/styles/globals.css`；改这里必须同步改 globals.css。

## 0. 技术选型（本次改版引入）

| 库 | 用途 | 约定 |
| --- | --- | --- |
| **Radix UI**（`@radix-ui/react-*`） | 全部浮层/表单控件的可达性行为（Dialog、DropdownMenu、Tooltip、Tabs、Switch、Checkbox、RadioGroup、Popover、Progress、Separator） | 只允许通过 `src/components/ui/*` 的封装使用，**业务代码不得直接 import Radix** |
| **motion**（`motion/react`，framer-motion 继任者） | 入退场编排、布局动画、拖拽反馈、共享元素指示器 | 页面级入场用 `PageTransition`（见 §5）；列表编排用 `<motion stagger>`；浮层动画统一在 ui 封装内部实现，业务侧不重复写 |
| **sonner** | Toast 渲染引擎（`useToast()` API 不变，业务无感） | 只在 `components/ui/toast.tsx` 出现 |
| **class-variance-authority** | Button/Badge 等多 variant 组件的样式组合 | 仅 ui 层使用 |

## 1. 设计 token（globals.css `@theme`，浅色为默认、深色挂在 `[data-ui-theme="dark"]`）

### 1.1 色板

**原则：** 中性色带一点冷紫灰调；表面分三层（app < surface < raised）；主色是「靛蓝→紫」的渐变
`linear-gradient(135deg, #6366f1, #8b5cf6)`；状态色保留六态语义，深色下 soft 底 = 主色 14% 透明度。

| token | 浅色 | 深色 | 用法 |
| --- | --- | --- | --- |
| `bg-app` | `#f4f5fa` | `#0f1118` | 窗口底 |
| `bg-surface` | `#ffffff` | `#161926` | 卡片/抽屉/弹窗 |
| `bg-raised` | `#f7f8fc` | `#1d2130` | 输入框底、行 hover、次级面板 |
| `bg-muted` | `#eef0f7` | `#262b3c` | 分隔块、骨架屏、禁用底 |
| `border` | `#e4e7f0` | `#2a3044` | 常规边框 |
| `border-strong` | `#cdd3e4` | `#3a4159` | hover 边框、控件边框 |
| `text-primary` | `#181b27` | `#e9ebf4` | 主文本 |
| `text-secondary` | `#5d6474` | `#9ba3ba` | 次文本 |
| `text-tertiary` | `#939cb0` | `#6a7188` | 辅助文本 |
| `text-inverse` | `#ffffff` | `#ffffff` | 主按钮文本 |
| `primary` | `#5a51e8` | `#7c74ff` | 主操作（深色下提亮） |
| `primary-hover` | `#4a41d4` | `#8d86ff` | 主操作 hover |
| `primary-light` | `#ecebfe` | `rgba(124,116,255,0.16)` | 选中底、导航激活底 |
| `primary-ring` | `rgba(90,81,232,0.35)` | `rgba(124,116,255,0.45)` | focus ring |

状态色（主色 / soft 底，六态 + pinned）：

| 语义 | 主色（浅/深同值，深色下亮 10%） | soft 浅色 | soft 深色 |
| --- | --- | --- | --- |
| backlog 需求池 | `#8a93a8` | `#eef0f6` | `rgba(138,147,168,0.16)` |
| ready 待执行 | `#3b82f6` | `#e9f2fe` | `rgba(59,130,246,0.16)` |
| running 执行中 | `#f59e0b` | `#fdf3e0` | `rgba(245,158,11,0.16)` |
| review 待审核 | `#8b5cf6` | `#f1ecfe` | `rgba(139,92,246,0.16)` |
| done 已完成 | `#10b981` | `#e5f8f1` | `rgba(16,185,129,0.16)` |
| failed 异常 | `#ef4444` | `#fdecec` | `rgba(239,68,68,0.16)` |
| pinned 置顶 | `#f59e0b` | `#fdf3e0` | `rgba(245,158,11,0.16)` |

优先级四档沿用原语义（P0 红 `#dc2626` / P1 橙 `#ea580c` / P2 青 `#0891b2` / P3 灰 `#6b7280`），
soft 底规则同上（深色 = 14% 透明度）。

### 1.2 字体

- 字族不变：`Inter, "PingFang SC", "Microsoft YaHei", sans-serif`；等宽 `"JetBrains Mono", "SF Mono", monospace`。
- 字号档：`page-title` 20/28/600、`section-title` 16/24/600、`card-title` 14/20/500、`body` 14/22/400、
  `aux` 12/18、`code` 13/20 mono、`nav` 14/22/500、`badge` 12/18/500。
- **新增**：数字/时间/ID 一律叠 `tabular-nums`（工具类 `tabular-nums`），等宽场景仍用 `font-mono text-code`。

### 1.3 间距 / 圆角

- 间距基准 4px 不变（Tailwind 刻度即 px）。
- 圆角：`control` 8px、`tag` 6px、`card` 12px、`drawer` 16px（左侧两角）、`modal` 16px、`badge` 999px（胶囊）、`node` 10px。

### 1.4 阴影（浅色 / 深色各一套，深色更深更近）

| token | 浅色 | 深色 |
| --- | --- | --- |
| `card` | `0 1px 2px rgb(20 22 34 / .05), 0 1px 3px rgb(20 22 34 / .04)` | `0 1px 2px rgb(0 0 0 / .4)` |
| `card-hover` | `0 4px 8px -2px rgb(20 22 34 / .08), 0 16px 28px -8px rgb(20 22 34 / .10)` | `0 8px 24px -8px rgb(0 0 0 / .55)` |
| `card-drag` | `0 24px 48px -12px rgb(90 81 232 / .35), 0 8px 16px -8px rgb(20 22 34 / .12)` | 同浅色（彩色投影通用） |
| `drawer` | `-12px 0 40px -12px rgb(20 22 34 / .18)` | `-12px 0 40px -12px rgb(0 0 0 / .6)` |
| `modal` | `0 24px 64px -16px rgb(20 22 34 / .22), 0 4px 12px -4px rgb(20 22 34 / .08)` | `0 24px 64px -16px rgb(0 0 0 / .65)` |
| `pop`（菜单/气泡） | `0 8px 24px -8px rgb(20 22 34 / .14), 0 2px 6px -2px rgb(20 22 34 / .06)` | `0 8px 24px -8px rgb(0 0 0 / .6)` |

### 1.5 尺寸档（不变）

顶栏 56px（`h-14`）、列头 44px（`h-11`）、主按钮 32px（`h-8`）、小按钮 28px（`h-7`）、
列宽 280/240/折叠 40、卡片 248、抽屉 640/560/480 三档、弹窗 560、审核表单 720、通知面板 360。

### 1.6 动效 token

- 缓动：`ease-settle = cubic-bezier(.2,0,0,1)`（默认）、`ease-emphasis = cubic-bezier(.32,.72,0,1)`（浮层/抽屉）。
- 时长：hover/按压 140ms；浮层出入 200ms；页面过渡 240ms；状态高亮 800ms（`animate-status-flash` 保留）。
- motion 弹簧（业务侧直接 `import { springs } from '@/lib/motion'`）：
  - `springs.gentle = { type: 'spring', stiffness: 380, damping: 34 }` — 布局动画、指示器滑动
  - `springs.snappy = { type: 'spring', stiffness: 520, damping: 40 }` — 拖拽落点、开关
  - `springs.pop = { type: 'spring', stiffness: 600, damping: 30 }` — 徽标数字、小元素弹出
- 过渡曲线常量：`transitions.fade = { duration: 0.14 }`、`transitions.rise = { duration: 0.24, ease: [0.32, 0.72, 0, 1] }`。

## 2. 组件库契约（`src/components/ui/*`）

**对外 API 与改版前保持兼容**（组件名、props 名、导出名都不变），业务侧只需要做视觉层调整。
交互行为一律由 Radix 提供，动画一律由 motion/sonner 提供。要点：

- `Button`：6 variant（primary/default/ghost/danger/outlineDanger/subtle）× 4 size（md/sm/icon/iconSm）。
  primary 用渐变底 + 顶部内高光；按压 `active:scale-[.98]`；loading 转圈不变。
- `Dialog`：Radix Dialog + AnimatePresence；遮罩 `bg-black/45 backdrop-blur-[2px]`（深色 `/60`）；
  面板出入 = 缩放 0.96→1 + 上移 8px + 淡入，`ease-emphasis` 200ms。
- `Drawer`：Radix Dialog（右侧 sheet）+ 弹簧滑入（`ease-emphasis` 260ms）+ 遮罩淡入；宽度档不变。
- `Menu`：Radix DropdownMenu 封装；**render-prop 触发器 API 不变**；出入 = 缩放 0.97→1 + 淡入 140ms；
  分组分隔、danger 描红、选中对勾、快捷键 hint 槽位全部保留。
- `Tooltip`：Radix Tooltip，延迟 300ms，深色底胶囊、小箭头；出入淡入 + 轻微上浮。
- `Tabs`：`segmented` 用 motion `layoutId` 滑动胶囊做激活指示；`underline` 用滑动下划线。
- `Select`：保持原生 `<select>`（桌面 WebView 原生面板键盘/IME 体验最好），只换皮：raised 底、focus ring。
- `Checkbox` / `RadioGroup` / `Switch`：Radix 封装；勾选/圆形指示带 spring 微弹（scale 0→1）。
- `Toast`：sonner 渲染，`useToast()` 的 `success/error/warning/info(text, detail?)` API 不变；
  顶部居中、图标描边、错误停留 6s 规则保留。
- `Table` / `Pagination` / `Skeleton` / `EmptyState` / `Progress` / `Card` / `Badge`：API 不变，换新皮肤。
- `StatusDot` / `TagBadge`：不变，配合 `statusStyle()` 使用。

**禁止**：业务代码直接 import Radix/motion 之外的浮层实现；自绘 position: fixed 菜单；引入新的 CSS 类名体系。

## 3. 应用外壳

- **顶栏**：`h-14` 毛玻璃（`bg-surface/80 backdrop-blur-xl`）+ 底部 1px 边框；左侧渐变 Logo 标 + 应用名；
  中部导航为胶囊式，激活项由 motion `layoutId="nav-pill"` 滑动指示；右侧主题切换（太阳/月亮/显示器三态循环）
  + 通知铃铛（角标数字变化带 `springs.pop` 弹跳）。
- **页面过渡**：`AppShell` 内用 `AnimatePresence mode="wait"` + `PageTransition` 包裹当前页
  （淡入 + 上移 6px，240ms `ease-emphasis`）；路由切换不保留滚动（与现状一致）。
- **主题**：`lib/theme.ts` 的 `applyUiTheme` 继续落 `<html data-ui-theme>`；顶栏切换即
  `PATCH /settings { ui_theme }`（乐观更新本地缓存），三态循环 浅色→深色→跟随系统。

## 4. 业务页面规范（子 agent 分工边界）

| 页面 | 文件目录 | 重点 |
| --- | --- | --- |
| 看板 | `src/features/board/` | 列头彩色徽标+计数胶囊；卡片 hover 抬升（-2px + card-hover 阴影）、顶部状态色细轨；拖拽 overlay 倾斜 2° + card-drag 阴影；列内卡片用 AnimatePresence + stagger 入场；执行中卡片保留倒计时/进度条（进度条加流动高光）；置顶卡片图钉角标 |
| 任务列表 | `src/features/task-list/` | 表格：表头吸顶 + raised 底；行 hover primary-light 淡底 + 左侧 2px 主色指示条；筛选面板改用 Popover（沿用现有 Menu 亦可）；批量操作条做成底部浮动胶囊条（带滑入动效） |
| 审核 | `src/features/review/` | 队列卡片 + 当前审核表单分栏布局保持；表单卡片顶部加审核任务摘要头；通过/驳回按钮强调（通过=primary 渐变、驳回=outlineDanger）；队列项切换用 layout 动画 |
| 设置 | `src/features/settings/` | 左侧分区导航（sticky）+ 右侧内容卡片；每个 Tab 内容块用 Card 分组 + 标题行；Token 列表行 hover 操作浮现；危险区（清空/导入）描红边框 |
| 任务详情 | `src/features/task-detail/` | 抽屉内：头部任务元信息两列网格；Tab 内容区切换淡入；产物列表行 hover 浮现操作；diff/图片查看器工具栏悬浮胶囊化 |

**业务 agent 的硬约束：**

1. **只改视觉与动效层**——不改 API 调用、mutations、queries、store、路由、业务逻辑；不改 `src/api/`、`src/ws/`、`src/lib/`（除非任务说明明确允许）。
2. 只用 `@/components/ui` 的组件 + Tailwind 工具类 + token；需要新基础组件时先在产出说明中提出，不要自己造。
3. motion 只用于：入场/退场编排（`AnimatePresence` + variants）、`layout`/`layoutId` 布局动画、
   拖拽反馈、徽标弹跳。**不要**给滚动、数据刷新、文本内容变化加动画。
4. 动效要克制：同屏同时动的元素 ≤ 1 组；列表 stagger 间隔 ≤ 40ms、单卡时长 ≤ 300ms；
   尊重 `prefers-reduced-motion`（motion 的 `useReducedMotion` 或 CSS media query）。
5. 深浅两套主题都要成立：颜色一律走 token（`bg-surface`、`text-secondary`…），**禁止硬编码 hex**；
   半透明遮罩类（`bg-black/45`）除外。
6. 文案、字段、错误处理、快捷键行为一律不动。
7. 改完必须通过：`npm run typecheck -w @atb/web`。

## 5. 通用片段

- **页面入场**（页面根元素）：`<motion.div initial={{ opacity: 0, y: 6 }} animate={{ opacity: 1, y: 0 }} transition={transitions.rise}>`。
- **列表入场**：父容器 `variants` 里 `staggerChildren: 0.04`，子项 `{ hidden: { opacity: 0, y: 8 }, show: { opacity: 1, y: 0 } }`。
- **数字徽标**：`<motion.span key={count} initial={{ scale: 0.6 }} animate={{ scale: 1 }} transition={springs.pop}>`。
- **卡片 hover**：CSS 即可——`transition-[transform,box-shadow,border-color] duration-140 ease-out hover:-translate-y-0.5 hover:shadow-card-hover hover:border-border-strong`。
- **滚动条**：全局 `.atb-scroll` 已提供细滚动条样式，容器沿用。
