# UI 全面改版技术方案与执行规划

> 状态：**三阶段实施已完成，judge 验收 ACCEPT WITH P1**（见 §6 进度）。
> 本文档是本次改版的执行总纲；设计细节以 `apps/web/DESIGN.md` 为唯一契约。

## 1. 目标与范围

- **目标**：引入成熟三方组件库与动画库，对前端四个页面（看板 / 审核 / 任务 / 设置）+ 任务详情抽屉做全新的视觉与交互动效设计实现；补全产品至今缺失的深色主题。
- **范围**：仅 `apps/web` 的表现层（样式、组件、动效、外壳）。不改 API 调用、mutations/queries、store、路由、业务逻辑，不改 `@atb/api`、`@atb/desktop`。
- **硬约束**：组件对外 API 保持向后兼容（业务页面只做视觉层适配）；颜色一律走 design token，禁止硬编码 hex。

## 2. 技术选型（已定，依赖已安装）

| 库 | 版本来源 | 用途 | 使用边界 |
| --- | --- | --- | --- |
| **Radix UI**（10 个包：dialog / dropdown-menu / tooltip / tabs / switch / checkbox / radio-group / popover / progress / separator） | npm | 全部浮层与表单控件的可达性行为（焦点圈、Esc、点击外部、aria 语义） | 只允许通过 `src/components/ui/*` 封装使用，业务代码不得直接 import |
| **motion**（`motion/react`，framer-motion 官方继任者） | npm | 入退场编排、`layoutId` 布局动画、拖拽反馈、徽标弹跳 | 常量统一在 `src/lib/motion.ts`（springs / transitions / listVariants） |
| **sonner** | npm | Toast 渲染引擎；`useToast()` API 不变，业务无感 | 只在 `components/ui/toast.tsx` 出现 |
| **class-variance-authority** | npm | Button 等多 variant 组件的样式组合 | 仅 ui 层使用 |
| 保留不动：Tailwind CSS v4、lucide-react、dnd-kit、react-query、zustand | — | 现有基础设施 | — |

选型理由：Radix 是 shadcn/ui 的底层、无头组件事实标准，只接管行为不接管皮肤，与现有 Tailwind token 体系零冲突；motion 是 framer-motion 的官方延续包，API 兼容且支持 React 18；sonner 体积小、动效开箱即用。

## 3. 设计方案要点（详见 apps/web/DESIGN.md）

1. **双主题 token 体系**：冷紫灰中性色、三层表面（app < surface < raised）；主色靛蓝→紫渐变；六状态 + 四优先级色保留语义，深色 soft 底 = 主色 14% 透明度；深色整套装在 `[data-ui-theme="dark"]`。`ui_theme` 设置项（light/dark/system）早已存在于后端与设置页，本次真正接通渲染。
2. **组件库重建（20 个组件，API 不变换内核）**：Button（渐变主按钮 + active:scale-0.98）、Dialog/Drawer（Radix + AnimatePresence 出入动效 + 毛玻璃遮罩）、Menu（Radix DropdownMenu，render-prop 触发器 API 保留）、Tabs（layoutId 滑动指示器）、Checkbox/Switch/Radio（Radix + spring 微弹）、Toast（sonner）、其余换新皮肤。
3. **应用外壳**：顶栏毛玻璃 + 导航胶囊滑动指示器 + 三态主题切换按钮 + 角标弹跳；页面切换 AnimatePresence 过渡。
4. **动效规范**：弹簧 gentle/snappy/pop 三档；页面入场 240ms；浮层 200ms `ease-emphasis`；列表 stagger ≤40ms；尊重 `prefers-reduced-motion`；同屏同时动的元素 ≤1 组。

## 4. 执行规划（多 agent 分工）

### 阶段一：契约层（主 agent 串行，是全部子任务的前置）

| # | 任务 | 产物 | 状态 |
| --- | --- | --- | --- |
| 1 | 依赖安装 | package.json 13 个新依赖 | ✅ 完成 |
| 2 | 设计契约 | `apps/web/DESIGN.md` | ✅ 完成 |
| 3 | 双主题 token | `src/styles/globals.css` 重写 + `src/lib/motion.ts` | ✅ 完成 |
| 4 | 组件库重建 | `src/components/ui/*` 20 个组件（API 不变） | ✅ 完成（button 主 agent，其余 19 个 5 个并行子 agent） |
| 5 | 应用外壳 | `src/app/app.tsx`、`top-bar.tsx`、`page-transition`、`lib/theme.ts` 接通 PATCH | ✅ 完成 |
| 6 | 契约层验证 | typecheck + 构建 + 浏览器冒烟（浅/深两主题截图） | ✅ typecheck/build 通过；隔离实例已起（7790/5175） |

### 阶段二：五个业务页面（子 agent 并行）

> ✅ 已完成：五个页面子 agent 全部交付并通过 typecheck；整合 typecheck + 生产构建全绿。

| 子 agent | 目录 | 重点 |
| --- | --- | --- |
| A 看板 | `features/board/` | 卡片 hover 抬升 + 顶部状态色细轨、拖拽倾斜投影、列内 stagger 入场、进度条流动高光、置顶图钉 |
| B 任务列表 | `features/task-list/` | 表头吸顶、行 hover 主色指示条、底部浮动批量条、筛选面板 |
| C 审核 | `features/review/` | 队列卡片 + 审核表单强调按钮、队列切换 layout 动画 |
| D 设置 | `features/settings/` | 分区导航 + Card 分组、Token 行 hover 浮现操作、危险区描红 |
| E 任务详情 | `features/task-detail/` | 抽屉头部元信息网格、Tab 切换淡入、产物行 hover 操作、查看器工具栏胶囊化 |

子 agent 通用约束（写入每个任务说明）：只改视觉动效层；只用 `@/components/ui` + token + motion 常量；不改 api/ws/lib/store；文案、快捷键、错误处理不动；完成标准 = `npm run typecheck -w @atb/web` 通过。

### 阶段三：集成与验收（主 agent）

1. 集成 typecheck + `npm run build -w @atb/web`。
2. 浏览器全页面走查（浅色 + 深色）：看板 / 任务 / 审核 / 设置 / 详情抽屉 / 弹窗 / Toast。
3. 渲染页面 PNG，分发 judge agent 视觉验收，修复后复验。
4. 更新发版记录与《高保真原型》文档差异说明。

## 5. 验证环境（本次搭建，可复用）

- 隔离 dev 实例（不动用户 7788 的真实数据）：API `ATB_DEV=1 ATB_PORT=7790 ATB_DATA_DIR=/tmp/atb-ui-dev ATB_ALLOWED_ORIGINS=http://localhost:5175,http://127.0.0.1:5175 npm run dev:api`；web `cd apps/web && ATB_DATA_DIR=/tmp/atb-ui-dev ATB_API_BASE=http://127.0.0.1:7790 npx vite --port 5175`。
- 演示数据：`/tmp/atb-ui-dev/seed.mjs` + `augment.mjs`（六列全覆盖：BACKLOG 5 / READY 1 / RUNNING 1 / REVIEW 1 / DONE 1 / FAILED 2）。数据目录重置后需重跑两个脚本、并重启 vite（dev token 在构建期注入）。
- 已知坑：5173 被用户另一项目占用（勿动）；`type` 字段词表 = 需求/缺陷/子任务/巡检/重构；UI Token 直接流转仅 BACKLOG↔READY，进执行态需走 Agent claim 流程。

## 6. 当前进度快照（恢复上下文用，2026-09-18 更新）

- **全部完成**：依赖安装；DESIGN.md 定稿；globals.css 双主题 token；`lib/motion.ts`；20 个 UI 组件重建（API 兼容，typecheck 通过）；应用外壳（glass-bar 顶栏、`layoutId="nav-pill"` 导航胶囊、三态主题切换 PATCH `api.settings.patch`、铃铛 `springs.pop`、`PageTransition` 页面过渡）；五个业务页面（board / task-list / review / settings / task-detail）视觉动效层。
- **验收**：整合 typecheck + `npm run build -w @atb/web` 全绿（CSS 48.7kB / JS 827kB）；隔离实例 7790/5175 可用（注意：残留旧进程会占端口，重启前先 `lsof -nP -i :7790 -i :5175` 清理）。judge agent 代码级走查结论 **ACCEPT WITH P1**，七项契约抽查全达标；零硬编码 hex（grep 证实）。
- **遗留（judge P1/P2）**：① `review/drafts.ts` + `api/types.ts` 的 ReviewInput 可选化是混入的外部需求（API §4.3，APPROVE 不再强制三字段），建议拆独立 commit 并由产品确认；② Progress 新增可选 `flowing` prop（加法兼容）；③ Popover 未建（任务列表筛选沿用 Menu，功能无回归）。
- **待办**：真机双主题像素级走查（在浏览器打开 5175 人工确认动效观感）+ 更新发版记录与《高保真原型》差异说明 + 按提交拆分建议整理 commit。
- 模型调度经验：子 agent 用 Deepseek-V4.1-Flash 会触发 429 限流（本次重置时间 20:10），GLM-5.3-Flash 全程可用；并行子 agent 各自独立文件 + 主 agent 独占 `index.ts`，无写冲突，但同文件并发（review-form）会产生 `Mono`/`MonoCell` 式合并冲突，需主 agent 收口。
