import { useSyncExternalStore } from 'react';
import type { GraphTask } from '@/features/dependency-graph/layout';
import { DependencyGraphDialog } from '@/features/dependency-graph/DependencyGraphDialog';
import { useShellStore } from '@/app/store/shell';

/**
 * 2.md 8.1 全局依赖图的可接线入口。
 *
 * `features/dependency-graph` 的 `DependencyGraphDialog` 本身只是个受控 Dialog，
 * 谁挂载谁管 open——但看板工具栏 / 列表页工具栏（features/board、features/task-list
 * 的工具栏归并行任务）需要一个**命令式**的 `openDependencyGraph(...)`，
 * 所以这里给一个模块级小 store + 一次挂载的全局宿主：
 *
 * ```tsx
 * // app 壳层（overlay 区）挂一次：
 * import { DependencyGraphGlobalHost } from '@/features/requirements';
 * <DependencyGraphGlobalHost />
 *
 * // 任意入口（工具栏按钮 onClick）：
 * import { openDependencyGraph } from '@/features/requirements';
 * import { useBoard } from '@/api';
 * const board = useBoard(); // 或 useTaskList 等任何拿到 GraphTask 集合的地方
 * openDependencyGraph(board.data?.columns.flatMap((c) => c.tasks) ?? []);
 * ```
 *
 * `requirementId` 传了就按 8.2 过滤任务集合；任务 DTO 没有 `requirement_id` 字段时
 * 调用方应自己预过滤（与 `DependencyGraphDialog` 的注释同一口径）。
 */

interface GraphModalState {
  open: boolean;
  tasks: readonly GraphTask[];
  requirementId: string | null;
}

let state: GraphModalState = { open: false, tasks: [], requirementId: null };
const listeners = new Set<() => void>();

function setState(next: Partial<GraphModalState>): void {
  state = { ...state, ...next };
  listeners.forEach((listener) => listener());
}

/** 命令式打开依赖图。`tasks` 建议传快照（调用方刷新后重开即可）。 */
export function openDependencyGraph(tasks: readonly GraphTask[], requirementId?: string | null): void {
  setState({ open: true, tasks, requirementId: requirementId ?? null });
}

export function closeDependencyGraph(): void {
  setState({ open: false });
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** 全局宿主：壳层挂一次即可，别处只调 `openDependencyGraph`。 */
export function DependencyGraphGlobalHost() {
  const snapshot = useSyncExternalStore(
    subscribe,
    () => state,
    () => state,
  );
  return (
    <DependencyGraphDialog
      open={snapshot.open}
      onClose={closeDependencyGraph}
      tasks={snapshot.tasks}
      requirementId={snapshot.requirementId}
      // 节点点击 → 关掉图、打开任务详情抽屉（壳层单例，2.md 8.4）。
      onOpenTask={(taskId) => {
        closeDependencyGraph();
        useShellStore.getState().openTask(taskId);
      }}
    />
  );
}
