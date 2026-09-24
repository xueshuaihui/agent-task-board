# 看板分组 / 过滤（B13 → B15 收口 → §19.14 概念收口后的目录口径）

PRD 第七章的分组在前端的最终形态（§19.14，2026-09-24 拍板）：**看板 UI 上「分组」与
「需求」是同一概念，Group 实体从看板可见面整体下线**——本批零服务端改动，`group_id`
仍是数据模型/API 真值，只是看板不再暴露。看板永远渲染经典六列；
过滤条件全部走服务端（`GET /board?requirements=…&agents=…`，**恒不发 `groups=`**），
不再有客户端槽模型。历史四轮下线：B13-③ 删泳道视图（GroupedBoard/Swimlane/GroupSelector/useCrossGroupDrag）；
B15-② 删 `useGroupingState`/`useBoardFilterStore`/`filter-model`（三份真值并入 `useFilterStore`）；
B15-③ 删 `GroupFilterSidebar`/`GroupSwitcher`（入口统一为工具栏「筛选」弹层 + 结果区 chip 汇总条）；
§19.14（v0.0.4 W1）删 groups 筛选维（看板查询/URL/偏好读取时剥离丢弃、不回写；
`groups` store 键保留，唯一消费者是列表页作用域）。

## 现在各文件的职责

| 文件 | 职责 |
|---|---|
| `grouping/dimensions.ts` | 分组维度定义（group / requirement / type / priority / agent / tag / status）+ `GroupableTask`（TaskCard + group/requirement 归属字段的**接缝类型**）+ `toGroupable()` 翻译 + `UNASSIGNED_KEY` 等词表。消费方只剩 `filter-prefs.ts`（迁移值翻译）与任务列表分节。**禁改**：其 group 维 label「分组」唯一消费方是列表页分节菜单，与看板无关。 |
| `board/filter-prefs.ts` | 过滤偏好的持久化与迁移（纯模块，不碰 router）：v2 扁平形状读写 localStorage `atb.board.filter` + 服务端 prefs `board.filter`（双写、hydrate 竞态防护）；切片**不含 groups 位**——历史 groups 值与 v1 槽 `dim==='group'`、旧 `board.grouping` 的 groupIds/projectIds 一律读取时丢弃、不回写（旧键只读迁移链保留：primary/laneFilter 照常翻译）。 |
| `board/filter-url-sync.ts` | 过滤态 ↔ `#/board?…` 双向同步：挂载/跳转时 URL 优先，store 变更经 `replaceState` 回写、不产生历史条目。`custom_fields` 不进 URL；`groups=` 解析前经 `stripLegacyGroupsParam` 剥离丢弃（groups 的 URL 读写只剩列表路由）。 |
| `board/filter/options.ts` | 筛选弹层/chip 条共用的**五维**词表（`FILTER_DIMENSIONS`：需求/类型/优先级/Agent/标签）、从看板快照派生候选的 `deriveFilterOptions`（requirements/agents 无服务端词表接口）、整维回写 `setFilterDimension`。 |
| `board/filter/FilterMenu.tsx` | 工具栏唯一过滤入口：「筛选」按钮 + Popover，五维 ChipGroup，维内 OR、维间 AND。 |
| `board/filter/FilterChipsBar.tsx` | 结果区上方的已激活条件汇总条：一条条件一枚可删 chip。 |

## 消费方接线

- **看板**（`features/board/index.tsx`）：`toBoardQuery(filters)` 直接产出六列请求参数
  （§19.14 起恒无 groups 键），页面不再做可见性判；`graphTasks`（快照拉平）同时喂依赖图、
  筛选弹层候选与 chip 条。整页空态只在「默认视图（无任何过滤）且无卡」时替换六列。
- **任务列表**（`features/task-list/index.tsx`）：分节维度是本页显示偏好，存 `atb.tasks.groupBy`
  （`group-pref.ts`），入口为筛选行的「分组方式」菜单；group 维节标题查分组缓存富化真名。
  列表作用域 chip（`ActiveGroupScope`）消费 store 的 `groups` 键——该键只服务列表。
- **分组页**（`features/groups/groups-page.tsx`）：「查看任务」= `setDimension('groups',[id])`
  再跳看板。§19.14 起看板不再消费 groups，该跳转实际效果只剩列表作用域（W1 不动
  features/groups，后续批次收口）。

## 接缝汇总

- `GroupableTask` 的 group/requirement 展示字段：等后端卡片 DTO 直接带上后可删 `toGroupable`。
- 需求/Agent 候选从当前看板快照派生：过滤生效后候选随可见卡收缩，已选值由 chip 条兜底可见可删。
