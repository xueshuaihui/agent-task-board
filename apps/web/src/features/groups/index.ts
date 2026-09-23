/**
 * 0919 五章「分组」feature 的出口：页面与数据 hook。
 * 路由挂载点在 `app/router.tsx`（ROUTES.groups）与 `app/app.tsx`（PAGES）。
 * B15-③：`GroupSwitcher` 下线——分组维并入看板筛选弹层（`useFilterStore.groups`）。
 */
export { GroupsPage } from './groups-page';
export { GroupGlyph } from './group-glyph';
export { useGroups, useActiveGroups, useGroupMutations, groupsApi } from './queries';
export { useBoardWithGroups, useTaskListWithGroups, useSelectedGroupIds } from './use-group-scoped';
export type { Group, GroupCreateInput, GroupPatchInput, GroupDeleteResult } from './types';
