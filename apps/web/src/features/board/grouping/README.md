# 看板分组 / 过滤（B13 → B15 收口后的目录口径）

PRD 第七章的分组在前端的最终形态：**分组只是过滤的一个维度**。看板永远渲染经典六列；
过滤条件全部走服务端（`GET /board?groups=…&requirements=…&agents=…`），不再有客户端槽模型。
历史三轮下线：B13-③ 删泳道视图（GroupedBoard/Swimlane/GroupSelector/useCrossGroupDrag）；
B15-② 删 `useGroupingState`/`useBoardFilterStore`/`filter-model`（三份真值并入 `useFilterStore`）；
B15-③ 删 `GroupFilterSidebar`/`GroupSwitcher`（入口统一为工具栏「筛选」弹层 + 结果区 chip 汇总条）。

## 现在各文件的职责

| 文件 | 职责 |
|---|---|
| `grouping/dimensions.ts` | 分组维度定义（group / requirement / type / priority / agent / tag / status）+ `GroupableTask`（TaskCard + group/requirement 归属字段的**接缝类型**）+ `toGroupable()` 翻译 + `UNASSIGNED_KEY` 等词表。消费方只剩 `filter-prefs.ts`（迁移值翻译）与任务列表分节。 |
| `board/filter-prefs.ts` | 过滤偏好的持久化与迁移（纯模块，不碰 router）：v2 扁平形状读写 localStorage `atb.board.filter` + 服务端 prefs `board.filter`（双写、hydrate 竞态防护）；一次性迁移 v1 槽形状（slotA/slotB）与旧 `board.grouping`（groupIds/primary/laneFilter），服务端已是 v2 时不再合并 grouping（防已清空作用域复活）。 |
| `board/filter-url-sync.ts` | 过滤态 ↔ `#/board?…` 双向同步：挂载/跳转时 URL 优先，store 变更经 `replaceState` 回写、不产生历史条目。`custom_fields` 不进 URL。 |
| `board/filter/options.ts` | 筛选弹层/chip 条共用的六维词表（`FILTER_DIMENSIONS`）、从看板快照派生候选的 `deriveFilterOptions`（requirements/agents 无服务端词表接口）、整维回写 `setFilterDimension`。 |
| `board/filter/FilterMenu.tsx` | 工具栏唯一过滤入口：「筛选」按钮 + Popover，六维 ChipGroup，维内 OR、维间 AND。 |
| `board/filter/FilterChipsBar.tsx` | 结果区上方的已激活条件汇总条：一条条件一枚可删 chip。 |

## 消费方接线

- **看板**（`features/board/index.tsx`）：`toBoardQuery(filters)` 直接产出六列请求参数，页面不再做
  可见性判；`graphTasks`（快照拉平）同时喂依赖图、筛选弹层候选与 chip 条。整页空态只在
  「默认视图（无任何过滤）且无卡」时替换六列。
- **任务列表**（`features/task-list/index.tsx`）：分节维度是本页显示偏好，存 `atb.tasks.groupBy`
  （`group-pref.ts`），入口为筛选行的「分组方式」菜单；group 维节标题查分组缓存富化真名。
- **分组页**（`features/groups/groups-page.tsx`）：「查看任务」= `setDimension('groups',[id])` 再跳看板。

## 接缝汇总

- `GroupableTask` 的 group/requirement 展示字段：等后端卡片 DTO 直接带上后可删 `toGroupable`。
- 需求/Agent 候选从当前看板快照派生：过滤生效后候选随可见卡收缩，已选值由 chip 条兜底可见可删。
