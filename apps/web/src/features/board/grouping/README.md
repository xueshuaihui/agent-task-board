# 看板分组（B13：分组即过滤）

PRD 第七章的分组在前端的最终形态：**分组不再是泳道视图，而是过滤条件**。看板永远渲染经典六列；
左侧「分组侧栏」提供两个过滤槽，命中的卡片才显示。旧泳道路径（GroupedBoard/Swimlane/GroupSelector/
useCrossGroupDrag）已随 B13-③ 整体删除。

## 文件职责

| 文件 | 职责 |
|---|---|
| `filter-model.ts` | 纯函数状态机：`FilterSlot`（`{dim, values[]}`）× 两槽（slotA/slotB）、`taskMatchesSlot`（槽内多值 OR）、`taskMatchesFilter`（槽间交集 AND）、`hasActiveFilter`、`toggleSlotValue`、`slotStats`（侧栏徽标计数：total/审核中/执行中，未归属垫底）。`'status'` 维不可作过滤（列即状态）。 |
| `useBoardFilterStore.ts` | Zustand store：两槽偏好 + 全部动作（`setSlotDim`/`toggleValue`/`selectSlotValues`/`clearSlot`/`reset`）。持久化 localStorage `atb.board.filter` + 服务端 prefs `board.filter`（hydrate 竞态防护见文件内注释）。**B13-② 迁移**：本地无新值时读旧 `atb.board.grouping`（primary/secondary/laneFilter）翻译成槽并回写。 |
| `GroupFilterSidebar.tsx` | 过滤入口。≥`win-lg` 内联 w-56 面板；窄窗收成 w-9 竖轨（rail）+ 点击开 Drawer。每槽一段：维度 Select（排除另一槽占用维）+ 值行按钮（aria-pressed）+ 徽标计数 + 清除。 |
| `useGroupingState.ts` | 瘦身后的旧 store：只剩 `groupIds`（4.5 分组多选作用域，走服务端 `group_id` 过滤），供 GroupSwitcher/分组页/取数层消费。旧形状（primary/laneFilter 等）已被 filter store 接管，normalize 只兼容取值。 |
| `dimensions.ts` | 分组维度定义（group / requirement / type / priority / agent / tag / status）+ `GroupableTask`（TaskCard + group/requirement 归属字段的**接缝类型**）+ `toGroupable()` 翻译。 |

## 消费方接线

- **看板**（`features/board/index.tsx`）：六列快照拉平 → `toGroupable` → `taskMatchesFilter` 得 `visibleIds`，
  列渲染/总数/流程图共用同一过滤态；分组名/色经 `useGroups()` 缓存富化（`toGroupable` 的 `group_name` 兜底是裸 id）。
  整页空态只在「无过滤且无卡」时替换六列。
- **任务列表**（`features/task-list/index.tsx`）：分节维度读 `slotA.dim`（与侧栏共用一份偏好），
  group 维节标题同样查分组缓存富化真名。
- **分组页**（`features/groups/groups-page.tsx`）：「查看任务」= 写 `groupIds` 作用域 + `selectSlotValues('slotA','group',[id])` 再跳看板。
- **流程图视图**：与经典列共用 `visibleIds` 过滤态。

## 接缝汇总

- `GroupableTask` 的 group/requirement 展示字段：等后端卡片 DTO 直接带上后可删 `toGroupable`。
- 偏好持久化：`readBoardFilterPrefs`/`writeBoardFilterPrefs` 已切 `GET/PUT /api/v1/prefs/:key`（key=`board.filter`）。
