# features/requirements

0919「需求与子任务」需求侧能力：需求抽屉（2.md 6.1–6.3）、卡片需求进度角标（4.8）、
依赖图全局入口（8.1）。本 feature 不改 `features/board` / `features/task-list` 的现有文件
（看板页由并行任务负责），接线点集中在这里说明。

## 组件与导出（`index.ts`）

| 导出 | 用途 |
|---|---|
| `RequirementDrawerHost` | 需求抽屉挂载点。壳层在 overlay 区（与 `TaskDetailDrawer` 同层，如 `src/app/overlay-slot.tsx`）渲染一次。 |
| `useRequirementDrawerStore` | `openRequirement(id)` / `closeRequirement()`；任何入口 `useRequirementDrawerStore.getState().openRequirement(id)` 即开抽屉。 |
| `RequirementBadge` | 卡片需求角标。props：`parent`（卡片 DTO 的 `card.parent`）、可选 `onClick`。 |
| `openDependencyGraph(tasks, requirementId?)` | 命令式打开依赖图 Dialog（2.md 8.1）。`tasks: GraphTask[]`。 |
| `DependencyGraphGlobalHost` | 依赖图的全局宿主，壳层挂一次；配合 `openDependencyGraph` 使用。 |
| `closeDependencyGraph` | 编程关闭依赖图（一般用不到）。 |

## 主 agent 待接线清单

1. **需求抽屉宿主**：`app.tsx`（或 `overlay-slot.tsx`）在 `TaskDetailDrawer` 旁加
   ```tsx
   import { RequirementDrawerHost, DependencyGraphGlobalHost } from '@/features/requirements';
   <TaskDetailDrawer taskId={openTaskId} onClose={closeTask} />
   <RequirementDrawerHost />
   <DependencyGraphGlobalHost />
   ```
2. **卡片角标（2.md 4.8）**：`features/board/task-card-view.tsx` 卡片体内（阻塞徽标附近）：
   ```tsx
   import { RequirementBadge } from '@/features/requirements';
   {card.parent ? <RequirementBadge parent={card.parent} /> : null}
   ```
   `card.parent` 由后端卡片 DTO 直接带（`toCardDto` 的 `extra.parent`），不新增请求。
   要可点击打开需求抽屉就传 `onClick={() => useRequirementDrawerStore.getState().openRequirement(card.parent!.id)}`。
3. **依赖图全局入口（2.md 8.1）**：看板/列表工具栏「依赖图」按钮：
   ```tsx
   import { openDependencyGraph } from '@/features/requirements';
   import { useBoard } from '@/api';
   const board = useBoard();
   // onClick:
   openDependencyGraph(board.data?.columns.flatMap((column) => column.tasks) ?? []);
   ```
4. **需求泳道「查看需求」（6.4）**：泳道头按钮 `onClick={() => openRequirement(requirement.id)}`。

## 数据契约

- `TaskDetail.children` / `TaskDetail.aggregate`：后端 `GET /tasks/{id}` 的 `familyFields()`
  恒回（无子任务为 `[]` / `null`），前端类型见 `src/api/types.ts`（`TaskChildRef` / `TaskAggregate`）。
- 创建子任务：`POST /tasks` 带 `parent_task_id`；服务端校验父必须是「需求」、嵌套 ≤ 2 层
  （违规 422，`details[].code` = `parent_type` / `too_deep`）。
- 有子任务的父任务删除被 409 拒绝（先删/迁子任务）。

## 依赖图过滤口径

`DependencyGraphDialog` 按 `GraphTask.requirement_id` 过滤；任务 DTO 没有该字段，所以
需求抽屉的「依赖图」Tab 在传子任务集合时补了 `requirement_id: detail.id`（见
`requirement-drawer.tsx` 的 `GraphTab`）。全局图不传 `requirementId`。
