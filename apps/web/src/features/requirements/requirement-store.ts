import { create } from 'zustand';

/**
 * 需求抽屉的壳层宿主状态（与 `app/store/shell.ts` 的任务抽屉同一模式）。
 *
 * 单独成文件、不与 `requirement-drawer.tsx` 合在一起：任务详情抽屉的概览
 * （`features/task-detail/tabs/overview.tsx`）要点父任务行打开本抽屉，而抽屉组件
 * 反过来 import 任务详情的子任务列表组件——拆开才能避免模块环。
 *
 * 挂载点：壳层在 overlay 区渲染一次 `<RequirementDrawerHost />`（见本目录 README）。
 */
interface RequirementDrawerState {
  /** 非空即需求抽屉打开。 */
  requirementId: string | null;
  openRequirement: (id: string) => void;
  closeRequirement: () => void;
}

export const useRequirementDrawerStore = create<RequirementDrawerState>((set) => ({
  requirementId: null,
  openRequirement: (id) => set({ requirementId: id }),
  closeRequirement: () => set({ requirementId: null }),
}));
