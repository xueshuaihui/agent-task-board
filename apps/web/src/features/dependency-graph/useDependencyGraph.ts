import { useMemo } from 'react';
import { useQueries } from '@tanstack/react-query';
import { api, qk, useApiMutation } from '@/api';
import type { DependenciesResult, DependencyType } from '@/api/types';
import type { GraphEdgeInput, GraphTask } from './layout';

/**
 * 依赖图的数据层。读取模型（13 章）：服务端只有单任务的
 * `GET /tasks/{id}/dependencies`，所以图 = 对可见任务集合逐个拉取后并出去重。
 * 每个 id 一条 react-query 查询，key 复用 `qk.taskDependencies(id)`，
 * 于是任务详情抽屉「依赖」Tab 与本图共享缓存、WS 失效也一并生效。
 */

/** 把单任务的依赖结果折成 from=前置 的有向边。 */
function toEdges(id: string, result: DependenciesResult | undefined): GraphEdgeInput[] {
  if (!result) return [];
  const edges: GraphEdgeInput[] = [];
  for (const ref of result.depends_on) {
    edges.push({ depId: ref.dep_id, from: ref.id, to: id, type: normalizeType(ref.type) });
  }
  for (const ref of result.blocks) {
    edges.push({ depId: ref.dep_id, from: id, to: ref.id, type: normalizeType(ref.type) });
  }
  return edges;
}

function normalizeType(type: string): DependencyType {
  return type === 'relates' ? 'relates' : 'blocks';
}

/** 对 tasks 里每个任务拉一次依赖，返回去重后的边集合。 */
export function useDependencyEdges(tasks: readonly GraphTask[], enabled = true) {
  const queries = useQueries({
    queries: tasks.map((task) => ({
      queryKey: qk.taskDependencies(task.id),
      queryFn: () => api.tasks.dependencies(task.id),
      enabled,
    })),
  });

  const edges = useMemo<GraphEdgeInput[]>(() => {
    const seen = new Set<string>();
    const merged: GraphEdgeInput[] = [];
    tasks.forEach((task, index) => {
      for (const edge of toEdges(task.id, queries[index]?.data)) {
        const key = `${edge.from}\u0000${edge.to}\u0000${edge.type}`;
        if (seen.has(key)) continue;
        seen.add(key);
        merged.push(edge);
      }
    });
    return merged;
    // queries 数组引用每次渲染都变，按数据指纹判断即可。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tasks, queries.map((query) => query.dataUpdatedAt).join(',')]);

  const loading = queries.some((query) => query.isLoading);
  const error = queries.find((query) => query.error)?.error ?? null;

  return { edges, loading, error };
}

/** 6.2：添加依赖。环检测在后端（409 直接 Toast 服务端文案）。 */
export function useAddDependency() {
  return useApiMutation<{ taskId: string; dependsOn: string; type: DependencyType }, unknown>(
    ({ taskId, dependsOn, type }) => api.tasks.addDependency(taskId, { depends_on: dependsOn, type }),
    {
      invalidate: ({ vars }) => [
        // 两个端点的依赖 Tab 缓存都要清；['task'] 前缀一次盖掉抽屉全部 Tab。
        qk.taskAny,
        qk.boardRoot,
        qk.tasksRoot,
        // 前置任务的 blocks、下游任务的 depends_on 都变了，两端根 key 都失效。
        qk.taskRoot(vars.dependsOn),
      ],
    },
  );
}

/** 删除一条依赖行：depId 是依赖行主键，不是任务 id（20.3）。 */
export function useRemoveDependency() {
  return useApiMutation<{ taskId: string; depId: string }, unknown>(
    ({ taskId, depId }) => api.tasks.removeDependency(taskId, depId),
    {
      invalidate: [qk.taskAny, qk.boardRoot, qk.tasksRoot],
    },
  );
}
