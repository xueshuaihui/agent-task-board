import type { BreakdownDraft } from '@/api/types';

/**
 * §7.4 草案编辑的纯归约层（v0.0.4 W7 遗留 b1）。
 *
 * api 现状：breakdown 的 REST 只有 list/detail/confirm/cancel 四端点
 * （reportDraft 是 Agent 面 MCP `board.report_task_draft`，没有用户侧 REST 写入口），
 * 所以这里的编辑全部作用于**前端本地暂存**的草案数组：确认页的流程图、计数与
 * 5 秒撤销窗口都吃这份本地视图；真正落库要等 api 补出草案写端点（见交接清单）。
 *
 * 全部导出不依赖 React，便于单测（web 侧测试基建就绪后直接覆盖）。
 */

/** 新建草案的固定骨架；ref 由 nextDraftRef 生成，id 用 local- 前缀标明未落库。 */
export function makeDraft(ref: string, sortOrder: number): BreakdownDraft {
  return {
    id: `local-${ref}`,
    ref,
    title: '新任务',
    description: null,
    priority: 3,
    skill_ids: [],
    acceptance: [],
    depends_on: [],
    sort_order: sortOrder,
  };
}

/** 现有 ref 形如 t1/t2…；取数字后缀最大值 +1，无草案时回到 t1。 */
export function nextDraftRef(drafts: readonly BreakdownDraft[]): string {
  let max = 0;
  for (const draft of drafts) {
    const n = Number.parseInt(draft.ref.replace(/^\D+/, ''), 10);
    if (Number.isFinite(n)) max = Math.max(max, n);
  }
  return `t${max + 1}`;
}

/** 局部字段更新（不可变）。 */
export function patchDraft(
  drafts: readonly BreakdownDraft[],
  ref: string,
  patch: Partial<Omit<BreakdownDraft, 'id' | 'ref'>>,
): BreakdownDraft[] {
  return drafts.map((draft) => (draft.ref === ref ? { ...draft, ...patch } : draft));
}

/**
 * 删除草案（PRD §7.4「删除任务」）：级联清掉其它草案 depends_on 里的悬空引用，
 * 保证流程图与确认计数里不出现幽灵边。
 */
export function removeDraft(drafts: readonly BreakdownDraft[], ref: string): BreakdownDraft[] {
  return drafts
    .filter((draft) => draft.ref !== ref)
    .map((draft) =>
      draft.depends_on.includes(ref)
        ? { ...draft, depends_on: draft.depends_on.filter((dep) => dep !== ref) }
        : draft,
    );
}

/** 追加草案（空白处「添加任务」的归约入口）。 */
export function addDraft(drafts: readonly BreakdownDraft[]): BreakdownDraft[] {
  const ref = nextDraftRef(drafts);
  const sortOrder = drafts.reduce((max, draft) => Math.max(max, draft.sort_order), -1) + 1;
  return [...drafts, makeDraft(ref, sortOrder)];
}

/** start 是否（传递地）依赖 target——沿 depends_on 正向 BFS。 */
export function dependsReachable(
  drafts: readonly BreakdownDraft[],
  start: string,
  target: string,
): boolean {
  const byRef = new Map(drafts.map((draft) => [draft.ref, draft]));
  const seen = new Set<string>([start]);
  let frontier = [start];
  while (frontier.length > 0) {
    const next: string[] = [];
    for (const ref of frontier) {
      for (const dep of byRef.get(ref)?.depends_on ?? []) {
        if (dep === target) return true;
        if (seen.has(dep)) continue;
        seen.add(dep);
        next.push(dep);
      }
    }
    frontier = next;
  }
  return false;
}

export type DependencyToggleResult =
  | { ok: true; drafts: BreakdownDraft[] }
  | { ok: false; reason: 'self' | 'cycle' };

/**
 * 连/断依赖边（§7.4「依赖」+ §7.8「依赖成环：拒绝」的前端口径）：
 * to 依赖 from；若 from 已传递依赖 to（或自环）则拒绝，服务端确认时会二次兜底。
 */
export function toggleDependency(
  drafts: readonly BreakdownDraft[],
  from: string,
  to: string,
): DependencyToggleResult {
  if (from === to) return { ok: false, reason: 'self' };
  const current = drafts.find((draft) => draft.ref === to);
  if (!current) return { ok: true, drafts: [...drafts] };
  if (current.depends_on.includes(from)) {
    return {
      ok: true,
      drafts: patchDraft(drafts, to, {
        depends_on: current.depends_on.filter((dep) => dep !== from),
      }),
    };
  }
  if (dependsReachable(drafts, from, to)) return { ok: false, reason: 'cycle' };
  return {
    ok: true,
    drafts: patchDraft(drafts, to, { depends_on: [...current.depends_on, from] }),
  };
}

/** 当前草案集是否成环（Kahn 剥不掉即有环；与 dependency-graph/layout.ts 同一口径）。 */
export function hasDependencyCycle(drafts: readonly BreakdownDraft[]): boolean {
  const indegree = new Map<string, number>();
  const dependents = new Map<string, string[]>();
  for (const draft of drafts) {
    // 悬空引用（对端已删）与重复项不参与成环判断——removeDraft 已保证正常路径不会出现。
    const deps = [...new Set(draft.depends_on)].filter(
      (dep) => dep !== draft.ref && drafts.some((d) => d.ref === dep),
    );
    indegree.set(draft.ref, deps.length);
    for (const dep of deps) {
      const list = dependents.get(dep) ?? [];
      if (!list.includes(draft.ref)) list.push(draft.ref);
      dependents.set(dep, list);
    }
  }
  let queue = drafts.map((d) => d.ref).filter((ref) => (indegree.get(ref) ?? 0) === 0);
  let processed = 0;
  while (queue.length > 0) {
    const next: string[] = [];
    for (const ref of queue) {
      processed += 1;
      for (const child of dependents.get(ref) ?? []) {
        const remaining = (indegree.get(child) ?? 0) - 1;
        indegree.set(child, remaining);
        if (remaining === 0) next.push(child);
      }
    }
    queue = next;
  }
  return processed < drafts.length;
}
