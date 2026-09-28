/**
 * features/groups 出口。r6（§19.15·88，2026-09-28）：「分组」概念从 web UI 整体下线，
 * 分组管理页（groups-page）与新建/编辑、删除对话框（group-form-dialog /
 * group-delete-dialog）及 group-glyph 已删除，UI 不再渲染任何 Group 管理界面。
 * 本目录只保留仍有实际消费者的**数据层**（`group_id`/`/groups` 仍是存量数据与
 * REST/Agent 面真相，§19.15·91/92）：
 * - `queries.ts`：useGroups（唯一消费者 = `requirements/use-requirement-options.ts`
 *   的归档组剔除，§19.15·91 保留项）；useActiveGroups 自 r6 R3-C 起 **UI 消费者清零**
 *   （新建任务弹窗「分组」下拉与拆解浮层组名 badge 已退场），导出保留、不拆；
 *   useGroupMutations/groupsApi（端点封装保留）；
 * - `use-group-scoped.ts`：看板/列表两条数据腿（board/index.tsx 的
 *   useBoardWithGroups、task-list/index.tsx 的 useTaskListWithGroups），仍在用；
 * - `types.ts`：Group 形状与 GROUP_LIMIT 常量（服务端校验口径）。
 * B15-③：`GroupSwitcher` 早已下线——分组维并入统一过滤 store（`useFilterStore.groups`）。
 */
export { useGroups, useActiveGroups, useGroupMutations, groupsApi } from './queries';
export { useBoardWithGroups, useTaskListWithGroups, useSelectedGroupIds } from './use-group-scoped';
export type { Group, GroupCreateInput, GroupPatchInput, GroupDeleteResult } from './types';
