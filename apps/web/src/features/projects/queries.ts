import { useQuery, type UseQueryOptions } from '@tanstack/react-query';
import { qk, useApiMutation } from '@/api';
import { projectsApi } from './projectsApi';
import type {
  Project,
  ProjectCreateInput,
  ProjectDeleteResult,
  ProjectPatchInput,
} from './types';

export { projectsApi };
export type { Project, ProjectCreateInput, ProjectDeleteResult, ProjectPatchInput };

/** 与 api/queries.ts 的 Options 同一形状（项目查询只会用到这几个键）。 */
type Options<TData> = Pick<UseQueryOptions<TData, Error, TData>, 'enabled' | 'staleTime' | 'placeholderData'>;

export function useProjects(options?: Options<{ items: Project[] }>) {
  return useQuery({
    queryKey: qk.projects(),
    queryFn: projectsApi.list,
    staleTime: 30_000,
    ...options,
  });
}

/** 归档项目不进切换器与新建表单候选（5.1「归档的项目不出现在默认视图」）。 */
export function useActiveProjects(options?: Options<{ items: Project[] }>) {
  const query = useProjects(options);
  const items = query.data?.items.filter((project) => project.status === 'ACTIVE');
  return { ...query, data: query.data ? { items } : undefined };
}

/**
 * 项目写操作。三个口径：
 * - 删除/迁移动了任务归属，所以除 `projectsRoot` 外还要打 `boardRoot` 与 `tasksRoot`；
 * - 编辑/归档会影响看板的项目过滤与泳道展示，同样带上 board/tasks 前缀（代价是一次重取，正确性优先）；
 * - 表单类（create/patch/remove）由对话框内联回显字段错误，把默认 Toast 关掉；archive/restore 走默认 Toast。
 */
export function useProjectMutations() {
  const create = useApiMutation<ProjectCreateInput, Project>(projectsApi.create, {
    invalidate: [qk.projectsRoot],
    toastOnError: false,
  });

  const patch = useApiMutation<{ id: string; body: ProjectPatchInput }, Project>(
    ({ id, body }) => projectsApi.patch(id, body),
    { invalidate: [qk.projectsRoot, qk.boardRoot, qk.tasksRoot], toastOnError: false },
  );

  const archive = useApiMutation<string, Project>(
    (id) => projectsApi.patch(id, { status: 'ARCHIVED' }),
    { invalidate: [qk.projectsRoot, qk.boardRoot, qk.tasksRoot] },
  );

  const restore = useApiMutation<string, Project>(
    (id) => projectsApi.patch(id, { status: 'ACTIVE' }),
    { invalidate: [qk.projectsRoot] },
  );

  const remove = useApiMutation<
    { id: string; strategy: 'migrate' | 'delete'; targetProjectId?: string },
    ProjectDeleteResult
  >(
    ({ id, strategy, targetProjectId }) =>
      projectsApi.remove(id, {
        strategy,
        ...(strategy === 'migrate' && targetProjectId ? { targetProjectId } : {}),
      }),
    { invalidate: [qk.projectsRoot, qk.boardRoot, qk.tasksRoot, qk.taskAny], toastOnError: false },
  );

  return { create, patch, archive, restore, remove };
}
