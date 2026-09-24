# features/skills — 技能管理前端

对应需求：`docs/v0.0.4/需求.md` 第九章（技能管理，§9.3/9.4 编辑器三模式与块类型体系）、10.x（技能随任务下发）；
历史文档 `docs/0919/1.md` 8.3、`docs/0919/2.md` 第十一/十三章（编辑器细化）。

**只新增文件，未改动任何既有文件。** 后端尚未实现，前端按本目录 `api.ts` 的契约调用，
联调时后端按同一契约实现即可。

## 文件清单

| 文件 | 内容 |
| --- | --- |
| `types.ts` | Skill / SkillContent（块）/ McpDependency / 各输入输出类型 |
| `api.ts` | `skillsApi`（list/get/create/patch/remove/createVersion/rollback/test/export/import/boundTasks）+ `taskSkillsApi.set`（任务绑定） |
| `hooks.ts` | TanStack Query 封装（`skillKeys` + use* 查询与变更） |
| `meta.ts` | 类型/状态/块类型（PRD 15 类，1.md 8.3）的展示元数据与图标、模板起步 `templateContent`、semver 预览、连线校验、循环检测（`cyclicBlockIds`）、变量系统辅助（`inferVariableOptions`/`variableWarnings`） |
| `skill-library-page.tsx` | 技能库页（搜索/状态/来源筛选 + 分类 ChipGroup、卡片网格、新建/导入对话框挂载、编辑器路由） |
| `skill-card.tsx` | 技能卡片（类型徽标、三来源徽标 §9.10、版本、状态、绑定任务数、操作菜单；默认技能菜单项为「查看（只读）」进只读编辑器、同名追加 id 短后缀消歧） |
| `create-skill-dialog.tsx` | 新建技能两步向导：①名称/类型/起步方式（8 个内置模板摘要）②可选描述/标签，Enter 推进/提交 |
| `import-center-dialog.tsx` | 统一导入中心（W2 口径）：拖拽/选择 .atskill、SKILL.md、Cursor Rules .mdc，前端解析预览后走后端导入端点落库为「三方技能」；同名不算冲突直接共存，同 ID 冲突行内选「覆盖更新为新版本/跳过」（§9.8.4 r2） |
| `copy-skill-picker.tsx` | 复制技能选择器：GET /skills/:id 拿内容后 POST /skills 创建「副本」 |
| `skill-editor-page.tsx` | 编辑器整页（v0.0.4 W3 三模式，§9.4 内容实时同步）：模式 Tab（可视化/结构化/源码 + 流程图视图）共享同一份本地草稿 blocks + 保存草稿 + 发布 + 版本历史入口；默认技能（source=default）进整页只读态——横幅提示 + 各模式禁用编辑，服务端 SKILL_READONLY 403 兜底 |
| `skill-version-history.tsx` | W3 §9.6 编辑器版本工作流：头部「版本 n」按钮 → 历史列表（changelog/时间/当前标记）、「与当前对比」（拉快照做块级 diff）、「回滚到此版」（POST rollback，成功后草稿整体替换）；默认技能/无版本不渲染 |
| `version-diff.ts` | 版本 diff 纯函数：历史快照 vs 当前草稿按块 id 对齐（新增/删除/字段级修改/顺序/入口），`pos` 不计内容差异 |
| `block-editor.tsx` | 可视化模式：块增删/上下移/设入口 + dnd-kit 拖拽排序，字段表单共用 block-fields，next 分支用目标块下拉；readOnly 时隐藏全部操作、字段禁用 |
| `structured-editor.tsx` | 结构化模式（1.md 8.3）：表格式块列表（类型/标题/摘要 + 操作列），点行展开行内编辑完整字段，上移/下移/删除/在下方插入；readOnly 时撤操作列、展开行只读 |
| `source-editor.tsx` | 源码模式（1.md 8.3）：左侧 SKILL.md 源码编辑 + 右侧实时预览（无依赖轻量渲染），双向导入/导出，损失性转换 Toast 提示；readOnly 时源码只读、禁导入（导出/下载仍可用） |
| `block-fields.tsx` | 单块字段表单（可视化/结构化/流程图抽屉共用），按 15 类 kind 渲染对应字段；子技能块「技能插入」选择器（§9.4）：技能库按三来源分组+徽标、重名按 id 后 6 位消歧、选中写 `skillRef`（id，快照/导出兼容），库空退回手填；readOnly 用 fieldset disabled 统一禁用 |
| `variable-picker.tsx` | 变量插入下拉 + `{{变量}}` 光标处插入文本框（1.md 8.3 变量系统） |
| `markdown.ts` | SKILL.md <-> blocks 纯函数双向转换（约定见文件末尾注释块），frontmatter 为 YAML 子集 |
| `skill-flow-view.tsx` | 流程图视图：只读 SVG 分层拓扑（滚轮缩放、拖拽平移、适应画布） |
| `flow-canvas.tsx` | 流程图编辑画布（@xyflow/react，flow 类型技能按 §9.3 用流程图编辑器）：调色板点击/拖放加块、拖拽布点、拖线建分支、双击开块编辑抽屉；readOnly 时撤全部编辑交互 |
| `publish-dialog.tsx` | 发布对话框（2.md 11.3 + 1.md 8.6）：版本号预览、changelog、MCP 依赖编辑器、发布前检查（循环检测标红、变量拼写警告不阻断）、测试状态展示区 + 技能测试入口（模拟运行 POST /skills/:id/test；测试用例接口就位后按组件内接缝注释替换展示数据） |
| `mcp-dependency-editor.tsx` | MCP 依赖声明编辑器（server/tools/required/reason） |
| `skill-detail-drawer.tsx` | 详情抽屉：概览块预览 / 版本回滚 / 测试 / MCP 配置片段复制 / 绑定任务 / 导出 |
| `index.ts` | 对外导出 |

## SKILL.md 双向转换约定（源码模式）

完整约定见 `markdown.ts` 末尾注释块（`MARKDOWN_CONVENTION_HINT` 同步展示在源码模式 UI）：

- frontmatter：`name / description / version / category / tags / mcp_dependencies`（YAML 子集：标量 + `[a, b]` 单行数组，mcp_dependencies 用单行 JSON）。
- 正文：每个块 = 一个 `### 块标题` 小节，小节首行 `<!-- atb:kind -->` 标记类型 → 有标记即可无损往返；无标记按内容形状推断（损失性，导入时 Toast 列出）。
- 类型小节体：提示词/知识/人工/注释=段落；步骤=编号列表；条件=`判断条件：` + `- 当 x → 跳转：块标题`；循环=`循环条件：`+列表；并行=`合并策略：`+列表；工具=`工具：server/tool`(+参数模板)；脚本=围栏代码块；子技能=`引用技能：`；输入/输出=`输入：name（类型 t，必填）`；约束=`规则：`；错误处理=`失败策略：…，重试 n 次，超时 n ms`。
- `入口块：块标题` 行声明入口块；分支跳转按块标题解析回 id，解析不到保留为空并在可视化模式补齐。

## 路由与接线（主 agent 待办）

### 1. `/skills` 路由

hash 自研路由只认 `app/router.tsx` 的命名路由，需两处小改（本 feature 未动）：

```ts
// app/router.tsx
import { skillsRouteCandidate } from '@/features/skills';
// ROUTES 增加： skills: skillsRouteCandidate
// NAV_ORDER 追加：'skills'（顶栏入口，2.md 12.1 导航含「技能」）

// app/app.tsx
import { SkillLibraryPage } from '@/features/skills';
// PAGES 增加：skills: SkillLibraryPage
```

编辑器不再新增路由：`#/skills?edit=<skillId>` 由技能库页内部识别并整页挂载
`SkillEditorPage`，返回即 `#/skills`。

### 2. 任务详情「技能标签」Tab（1.md 10.2 随任务下发）

```tsx
import { taskSkillsApi, useSkills, type TaskSkillRef } from '@/features/skills';

// 读取绑定：task.skills（任务详情已有字段）→ [{skill_id, version?}]
// 保存绑定（复用现有 PATCH /tasks/:id，契约见 api.ts 注释）：
await taskSkillsApi.set(taskId, [{ skill_id: 'skl_x', version: 'v1.2.0' }]);
// 候选列表：useSkills({ status: 'PUBLISHED' })
```

### 3. 看板卡片技能角标（1.md 10.2 技能推荐）

看板侧只需要轻查询 + 详情抽屉：

```tsx
import { useSkills, SkillDetailDrawer } from '@/features/skills';
// 卡片角标：skill.current_version / status；点击打开
// <SkillDetailDrawer skillId={id} open onClose onEdit={(skill) => hash 跳 '#/skills?edit='+skill.id} />
```

### 4. （可选）并入 api 聚合

把 `features/skills/api.ts` 的实现搬进 `api/resources/skills.ts` 并挂到 `api/skills`、
key 并入 `api/keys.ts`（`hooks.ts` 顶部有注释标注了引用点），即可纳入统一 `qk` 失效。

## 契约补充（后端实现时注意）

1. `GET /skills/:id/tasks` — 详情抽屉「绑定任务」列表（`SkillBoundTaskList`）；
   只给了 `stats.bound_task_count` 不够展示，未实现时该 Tab 走空态。
2. `POST /skills/:id/versions` 额外收 `mcp_dependencies` —— 发布对话框随版本提交
   MCP 依赖声明（PATCH 契约里没有该字段，放版本里最贴合「发布即定契约」语义）。
3. `POST /skills/import` 前端固定走 multipart（`file` 字段），后端任选其一实现即可。
4. 发布 = `POST /versions`（服务端自增 semver 并设 current）+ `PATCH {status: 'PUBLISHED'}`，
   两条顺序执行；`previewNextVersion` 只是 UI 预告，真实版本号以后端返回为准。
5. W3 已实现：`GET /skills/:id/versions/:version` 版本快照（编辑器 diff 用；只读接口，
   默认技能也可读，仅无版本记录时 404）。

## 测试联调提示

`npx tsc --noEmit` 通过；后端未就绪时技能库页会显示加载失败 + 重试（错误走 `http`
统一 ApiError），导入/测试运行会 Toast 出具体接口错误。
