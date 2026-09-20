/**
 * 0919 五章「分组」feature 的出口：页面、切换器与数据 hook。
 * 路由挂载点在 `app/router.tsx`（ROUTES.groups）与 `app/app.tsx`（PAGES）。
 */
export { GroupsPage } from './groups-page';
export { GroupSwitcher } from './group-switcher';
export { GroupGlyph } from './group-glyph';
export { useGroups, useActiveGroups, useGroupMutations, groupsApi } from './queries';
export { useBoardWithGroups, useTaskListWithGroups, useSelectedGroupIds } from './use-group-scoped';
export type { Group, GroupCreateInput, GroupPatchInput, GroupDeleteResult } from './types';
