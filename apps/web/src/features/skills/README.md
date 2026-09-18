# features/skills — 技能管理前端

对应需求：`docs/0919/1.md` 第八章（技能管理）、10.2/10.3（技能推荐与随任务下发）；
`docs/0919/2.md` 第十章（技能库）、第十一章（技能编辑器）、第十三章（技能详情）。

**只新增文件，未改动任何既有文件。** 后端尚未实现，前端按本目录 `api.ts` 的契约调用，
联调时后端按同一契约实现即可。

## 文件清单

| 文件 | 内容 |
| --- | --- |
| `types.ts` | Skill / SkillContent（块）/ McpDependency / 各输入输出类型 |
| `api.ts` | `skillsApi`（list/get/create/patch/remove/createVersion/rollback/test/export/import/boundTasks）+ `taskSkillsApi.set`（任务绑定） |
| `hooks.ts` | TanStack Query 封装（`skillKeys` + use* 查询与变更） |
| `meta.ts` | 类型/状态/块类型的展示元数据、模板起步 `templateContent`、semver 预览、连线校验 |
| `skill-library-page.tsx` | 技能库页（搜索/类型/状态筛选、卡片网格、新建/导入对话框挂载、编辑器路由） |
| `skill-card.tsx` | 技能卡片（类型徽标、版本、状态、绑定任务数、操作菜单） |
| `create-skill-dialog.tsx` | 新建技能（2.md 10.3）：名称/类型/描述/标签/模板起步 |
| `import-skill-dialog.tsx` | 导入 .atskill（multipart POST /skills/import） |
| `skill-editor-page.tsx` | 编辑器整页：模式 Tab（可视化/流程图）+ 保存草稿 + 发布入口 |
| `block-editor.tsx` | 可视化模式：块增删/上下移/设入口，按 kind 切换表单，next 分支用目标块下拉 |
| `skill-flow-view.tsx` | 流程图视图：只读 SVG 分层拓扑（滚轮缩放、拖拽平移、适应画布） |
| `publish-dialog.tsx` | 发布对话框（2.md 11.3）：版本号预览、changelog、MCP 依赖编辑器、发布前检查 |
| `mcp-dependency-editor.tsx` | MCP 依赖声明编辑器（server/tools/required/reason） |
| `skill-detail-drawer.tsx` | 详情抽屉：概览块预览 / 版本回滚 / 测试 / MCP 配置片段复制 / 绑定任务 / 导出 |
| `index.ts` | 对外导出 |

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

## 测试联调提示

`npx tsc --noEmit` 通过；后端未就绪时技能库页会显示加载失败 + 重试（错误走 `http`
统一 ApiError），导入/测试运行会 Toast 出具体接口错误。
