import { useMemo, useRef } from 'react';
import type { TaskCard, TaskStatus, Template } from '@/api/types';
import { useShellStore, type ReviewPrefill } from '@/app/store/shell';
import type { ToastApi } from '@/components/ui';
import { markPendingMove } from './fly-motion';
import { dropVerdict } from './matrix';
import type { BoardMutations } from './mutations';
import type { DangerMoveTarget } from './dialogs';
import type { QuickCreateTarget } from './quick-create';

/**
 * 卡片上所有动作的入口，由 `BoardPage` 造一份往下传（列 → 卡片 → 菜单）。
 * 三个约束：
 * - `move` 只接受**已通过 4.5 矩阵本地判定**的目标，非法落点在这里也不该被调到；
 * - `review` / `stop` 只负责弹表单，提交在对话框内部完成（🔒 取消不发请求）；
 * - `create` 是列底新建，`target` 决定建完是否立刻流转到 READY。
 */
export interface CardActions {
  open: (card: TaskCard) => void;
  togglePin: (card: TaskCard) => void;
  move: (card: TaskCard, to: TaskStatus) => void;
  review: (card: TaskCard) => void;
  stop: (card: TaskCard) => void;
  archive: (card: TaskCard) => void;
  /** 6.13.1 的反向动作：只有归档行给入口（看板不渲染归档卡片，列表页勾了「包含已归档」才会遇到）。 */
  restore: (card: TaskCard) => void;
  remove: (card: TaskCard) => void;
  /** 4.3.1 规则 6：`DONE` 不可逆，重做走「新建任务 + 把原任务设为前置」。 */
  followUp: (card: TaskCard) => void;
  copyId: (card: TaskCard) => void;
  /** 3.4 / 3.1 的创建入口：`template` 只用来预填，落列仍由 `target` 决定。 */
  create: (target: TaskStatus, template?: Template) => void;
}

type Setter<T> = (value: T) => void;

/**
 * 造一份 `CardActions`。看板和任务列表页共用这一个实现（原型 3.8 第 822 行要求两处
 * `⋯` 是同一份动作集——动作集在 `card-menu.tsx`，动词的落地在这里，两样都不许各写一遍）：
 * 调用方只提供四个弹窗/抽屉的目标态 setter。
 *
 * mutation 对象每次渲染都是新的，直接进依赖会让 `actions` 每次都换身份，
 * 卡片上的 `memo` 就白写了（一次 WS 刷新要重渲上百张卡）。
 */
export function useCardActions(
  toast: ToastApi,
  mutations: BoardMutations,
  setStopTarget: Setter<TaskCard | null>,
  setDeleteTarget: Setter<TaskCard | null>,
  setQuick: Setter<QuickCreateTarget | null>,
  setDangerMove: Setter<DangerMoveTarget | null>,
): CardActions {
  const latest = useRef(mutations);
  latest.current = mutations;

  return useMemo<CardActions>(() => {
    const shell = () => useShellStore.getState();
    const run = () => latest.current;
    return {
      open: (card) => shell().openTask(card.id),
      togglePin: (card) => run().togglePin.mutate(card),
      archive: (card) => run().archive.mutate(card.id),
      restore: (card) => run().restore.mutate(card.id),
      stop: (card) => setStopTarget(card),
      remove: (card) => setDeleteTarget(card),
      review: (card) => shell().openReview(card.id),
      followUp: (card) => setQuick({ target: 'BACKLOG', dependsOn: { id: card.id, title: card.title } }),
      create: (target, template) => setQuick({ target, preset: template?.preset }),
      copyId: (card) => {
        const write = navigator.clipboard?.writeText(card.id);
        if (!write) {
          toast.error('复制失败', `请手动选中 ${card.id}`);
          return;
        }
        void write.then(
          () => toast.success('已复制任务 ID', card.id),
          () => toast.error('复制失败', `请手动选中 ${card.id}`),
        );
      },
      /** 4.5 的三种反馈都在这一处：✅ 才发请求（danger 的 ✅ 先过确认），🔒 弹表单，❌ 只 Toast。 */
      move: (card, to) => {
        const verdict = dropVerdict(card.status, to);
        if (verdict.kind === 'direct') {
          // 廿二 B：danger 的 ✅ 边（按失败结案）先弹确认——确认弹窗里才登记飞行标记并
          // 发请求，取消等于什么都没发生（与 🔒 的 StopDialog 同构）。
          if (verdict.rule.danger) {
            setDangerMove({ card, to, label: verdict.rule.label });
            return;
          }
          // §5.2 方案 A：用户发起的 ✅ 换列在此登记 pending-move（拖拽释放路径已被规则 5
          // 抑制）。旧列在快照回来前的每次渲染据此撤掉 exit、预挂 layoutId，
          // 数据落地同帧瞬时让位 → 新列挂载即飞行；服务端确认后标记过期，不再重放（§5.1）。
          markPendingMove(card.id, card.status, to);
          run().move.mutate({ id: card.id, to });
          return;
        }
        if (verdict.kind === 'form') {
          // 松手弹表单，取消即回原列：这一步没发过任何请求。
          if (verdict.form === 'stop') setStopTarget(card);
          else shell().openReview(card.id, reviewPrefillForDrop(to));
          return;
        }
        if (verdict.kind === 'forbidden') toast.warning('不允许的流转', verdict.copy);
      },
    };
  }, [setQuick, setStopTarget, setDeleteTarget, setDangerMove, toast]);
}

/**
 * 4.5 末段 + 原型 3.7：`REVIEW → BACKLOG/READY` 是「驳回表单 + 退回目标＝拖放目标列」，
 * `REVIEW → DONE` 是「审核（结论预填通过）」。矩阵的 action 文案已经这么写，
 * 表单这边的预填由这一个映射喂，两处不再各判一次。
 */
function reviewPrefillForDrop(to: TaskStatus): ReviewPrefill | null {
  if (to === 'BACKLOG' || to === 'READY') return { conclusion: 'REJECT', returnTo: to };
  if (to === 'DONE') return { conclusion: 'APPROVE' };
  return null;
}
