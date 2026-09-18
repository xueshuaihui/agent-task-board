/**
 * 0919 五章「项目」feature 的出口：页面、切换器与数据 hook。
 * 路由挂载点在 `app/router.tsx`（ROUTES.projects）与 `app/app.tsx`（PAGES）。
 */
export { ProjectsPage } from './projects-page';
export { ProjectSwitcher } from './project-switcher';
export { ProjectGlyph } from './project-glyph';
export { useProjects, useActiveProjects, useProjectMutations, projectsApi } from './queries';
export { useBoardWithProjects, useTaskListWithProjects, useSelectedProjectIds } from './use-project-scoped';
export type { Project, ProjectCreateInput, ProjectPatchInput, ProjectDeleteResult } from './types';
