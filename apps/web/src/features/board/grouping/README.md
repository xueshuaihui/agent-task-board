# 看板分组（泳道）

PRD 1.md 第七章（7.1–7.9）+ 原型 2.md 第四章（4.1–4.12）的看板分组前端核心。本目录**只新增文件**，不改任何现有共享文件；board 页接线方式见文末。

## 文件职责

| 文件 | 职责 |
|---|---|
| `dimensions.ts` | 分组维度定义（project / requirement / type / priority / agent / tag / status）+ `GroupableTask`（TaskCard + project/requirement 归属字段的**接缝类型**，等后端卡片 DTO 带上这些字段后可直接删掉扩展） |
| `grouping.ts` | 纯函数分组引擎：`buildSwimlanes()`（任务 → 泳道 → 次分组 → 状态列）、`applyLaneOrder()`（7.6 拖拽排序持久化后的重排）、`filterLanes()`（7.6 筛选分组）、`classifyDrag()` + `patchForLane()`（4.9 拖拽矩阵与归属补丁） |
| `useGroupingState.ts` | Zustand store：主/次维度、泳道折叠、分组筛选、多项目、组内排序；偏好经 `useGroupingPrefs` 持久化（当前 localStorage，接缝注释在 `readGroupingPrefs`/`writeGroupingPrefs`，约定 `GET/PUT /api/v1/prefs/:key`，key=`board.grouping`） |
| `Swimlane.tsx` | 泳道布局：`SwimlaneView`（泳道容器 + 次分组行 + 状态列网格）+ `LaneColumnHead`（4.3 列头）。卡片通过 `renderCard` 注入，不重复实现卡片 |
| `SwimlaneHead.tsx` | 4.2 泳道头：折叠、统计（任务数/待审核数）、需求泳道元信息行（项目/优先级/进度条/查看需求）、dnd-kit 拖拽把手（7.6 泳道排序） |
| `GroupSelector.tsx` | 4.6 分组选择器对话框：主分组单选、次分组下拉、四个分组选项，「应用」才提交 |
| `GroupMoreMenu.tsx` | 4.10 泳道 ⋯ 菜单：重命名/折叠/只看/隐藏 + 排序 + 导出/归档（后两项是回调接缝） |
| `useCrossGroupDrag.ts` | 4.9 跨分组拖拽确认逻辑：`onDragEnd` 识别落点，跨分组转确认对话框（文案按原型），`onChangeGroup(taskId, patch, to?)` / `onChangeStatus` 回调接缝 |

## 泳道/落点 id 约定（dnd-kit）

- 泳道容器：`lane:{laneKey}`（SwimlaneHead 同时是 sortable，id 同上）
- 状态列容器：`column:{laneKey}:{status}`
- 卡片：`task:{id}`，且卡片 `data.laneKey` 必须带来源泳道 key（`useCrossGroupDrag` 依赖它判「跨分组」）

## board 页接线方式

1. **取数**：现有 `useBoard` 的六列快照拉平成 `GroupableTask[]`（`columns.flatMap(c => c.tasks)`）；project/requirement 字段等 API 补齐后透传即可。
2. **分组**：`buildSwimlanes({ tasks, primary, secondary, showEmptyLanes })` → `applyLaneOrder(lanes, laneOrder[primary] ?? [])` → `filterLanes(lanes, laneFilter)`；store 用 `useGroupingStore`（或 `useGroupingPrefs` 只读偏好）。
3. **渲染**：外层包 `DndContext` + `SortableContext`（items = `lane:{key}` 列表）；每条泳道渲染 `SwimlaneView`，`renderCard` 传现有 `DraggableCard`（board-card.tsx）；泳道头排序的 `onDragEnd` 里对泳道数组重排后调 `setLaneOrder(primary, newOrder)`。
4. **拖拽**：`useCrossGroupDrag({ callbacks, laneLabels, laneDimensions, tasks })` 的 `onDragEnd` 挂到同一个 `DndContext`（注意与泳道排序的 onDragEnd 按 `active.id` 前缀分流，或用两个 DndContext）；确认框用现有 `Dialog` 渲染 `confirmText`，按钮接 `accept`/`cancel`；`onChangeGroup`/`onChangeStatus` 接 board 现有 mutations（状态流转）与未来的归属 mutation。
5. **工具栏**：`GroupSelector` 由工具栏「分组」按钮开关；「全部折叠/展开」调 `collapseAll(primary, laneKeys, true/false)`；项目多选切换器（4.5）写 `toggleProject`，选中 >1 项目时把 `primary` 置为 `project`（PRD 4.5 末段）。

## 接缝汇总

- `GroupableTask` 的 project/requirement 字段：等后端 20.7 卡片 DTO 扩展。
- `patchForLane()` 的补丁字段名：等归属变更 API 定稿。
- `readGroupingPrefs`/`writeGroupingPrefs`：切 `GET/PUT /api/v1/prefs/:key`（`board.grouping`，value 为 GroupingPrefs JSON），hook 签名不变。
- `GroupMoreMenu` 的 `onExport`/`onArchiveDone`：接导出与归档 mutations。
