import type { TaskDetail } from '@/api';
import { COPY } from '@/lib/copy';
import {
  directTransitions,
  FORM_ACTION,
  type MatrixTarget,
  type TransitionKey,
} from '@/features/board/matrix';

/**
 * 原型 4.9 底部操作栏 + 4.2 右上 `⋯` 的**唯一动作来源**。
 *
 * 原型 3.3 / 3.7 要求「与 PRD 4.3 操作表、4.5 拖拽矩阵同一套判定，前端不再自行组合」，
 * 所以状态机本身不在这个文件里：可流转的目标列、动作名、danger 全部来自
 * `features/board/matrix.ts` 的 `directTransitions(status)`（4.5 里 ✅ 的那几格）。
 * 这里只补矩阵不知道的三件事：
 * 1. 放到哪个槽位——`primary` = 右一主色按钮、`secondary` = 次级按钮、`menu` = 收进 `⋯`；
 * 2. 次按钮/菜单项上那句补充说明，以及需要二次确认的动作的文案（4.5 文案表）；
 * 3. 矩阵里没有的动作：审核 / 退回重跑 / 查看日志 / 强制停止 / 归档 / 恢复 / 删除。
 *
 * 因此本文件**没有任何 `to:` 字面量**：想多给一个落点，只能去改矩阵那张表；
 * 而 `TRANSITION_SLOT` 是 `Record<TransitionKey, …>`，矩阵新增 ✅ 流转时这里漏配就编译不过。
 * 动作名逐字取 4.9 表（= 矩阵的 `label`），界面不自造同义词（「重新执行」「直接完成」这类按钮不存在）。
 */

export type ActionId =
  /** 4.5 的 ✅ 流转：键与目标列都在矩阵里，这里只是把同一批 id 收进联合类型。 */
  | TransitionKey
  /** 以下都是矩阵不认识的动作（🔒 表单入口与非流转项）。 */
  | 'stop'
  | 'view_logs'
  | 'review'
  | 'reject_rerun'
  | 'archive'
  | 'restore'
  | 'delete';

export interface TaskAction {
  id: ActionId;
  label: string;
  slot: 'primary' | 'secondary' | 'menu';
  danger?: boolean;
  /** 次按钮/菜单项上的一句补充说明。 */
  hint?: string;
  /** 需要二次确认的动作带的文案（4.5 文案表）。 */
  confirm?: { title: string; body: string };
  /**
   * 点击后走状态流转（`to` 非空即 transition 接口）。
   * 类型是矩阵签发的 `MatrixTarget` 而不是 `TaskStatus`：这里想写 `to: 'DONE'` 也编译不过，
   * 落点只可能来自 4.5 那张表（原型 3.3「不在前端另写一套规则」的编译器版本）。
   */
  to?: MatrixTarget;
}

/** ✅ 流转到抽屉里的落位：只说「放哪个槽、补一句什么」，目标列与动作名由矩阵给。 */
const TRANSITION_SLOT: Record<TransitionKey, { slot: TaskAction['slot']; hint?: string }> = {
  confirm_ready: { slot: 'primary' },
  withdraw: { slot: 'secondary', hint: '→ 需求池' },
  retry: { slot: 'primary', hint: '→ 待执行' },
  back_to_backlog: { slot: 'secondary' },
};

/** 4.5「将同时删除 {n} 条执行记录及其产物…」的 n / m 两个数字。 */
export function deleteConfirmBody(detail: TaskDetail): string {
  const downstream = detail.blocks.filter((item) => item.status !== 'DONE').length;
  return COPY.deleteConfirm(detail.run_count, downstream);
}

/** 矩阵给的 ✅ 流转 → 抽屉按钮：`to`/`label`/`danger` 原样透传，与拖拽、卡片菜单是同一批规则对象。 */
function transitionActions(status: string): TaskAction[] {
  return directTransitions(status).map((rule) => {
    const placement = TRANSITION_SLOT[rule.key];
    return {
      id: rule.key,
      label: rule.label,
      slot: placement.slot,
      hint: placement.hint,
      danger: rule.danger,
      to: rule.to,
    };
  });
}

/**
 * 4.9 表里 `⋯` 内的删除：`RUNNING` 不给（4.3.1 规则 4 要先强制停止），
 * 归档态也不给（`actionsFor` 在更早就分叉了）。确认文案取 4.5 的 N/M 那句。
 */
function deleteAction(detail: TaskDetail): TaskAction {
  return {
    id: 'delete',
    label: '删除',
    slot: 'menu',
    danger: true,
    confirm: { title: '删除任务', body: deleteConfirmBody(detail) },
  };
}

/** 矩阵不认识的那部分按钮（4.9 表里的非流转主/次按钮，以及 `⋯` 内的删除）。 */
function extraActions(detail: TaskDetail): TaskAction[] {
  switch (detail.status) {
    case 'BACKLOG':
    case 'READY':
    case 'FAILED':
      return [deleteAction(detail)];
    case 'DONE':
      return [
        // 6.13.1：归档只对 `DONE` 开放，改的是 `archived_at` 不是状态，矩阵里没有这一格。
        { id: 'archive', label: '归档', slot: 'primary' },
        deleteAction(detail),
      ];
    case 'RUNNING':
      return [
        {
          id: 'stop',
          // 与 4.5 的 🔒 格、3.7 的列头徽标同一个字符串。
          label: FORM_ACTION.stop,
          slot: 'primary',
          danger: true,
          confirm: { title: FORM_ACTION.stop, body: COPY.stopConfirm },
        },
        { id: 'view_logs', label: '查看日志', slot: 'menu', hint: '4.5' },
      ];
    case 'REVIEW':
      return [
        { id: 'review', label: '审核 →', slot: 'primary' },
        { id: 'reject_rerun', label: '退回重跑', slot: 'secondary', hint: '填驳回表单' },
      ];
    default:
      // 20.2 末段：库里出现表外状态时不给任何写入口，避免按猜的矩阵发请求。
      return [];
  }
}

export function actionsFor(detail: TaskDetail): TaskAction[] {
  if (detail.archived_at) {
    // 6.13.1：归档任务不在看板默认视图，只能从列表页进来；这里给「恢复」，不再给流转/归档/删除。
    return [{ id: 'restore', label: '恢复', slot: 'primary' }];
  }
  // 顺序即 4.9 表的读法：先矩阵给的流转（主按钮在前），再是本文件补的非流转动作。
  return [...transitionActions(detail.status), ...extraActions(detail)];
}

export function pickAction(actions: readonly TaskAction[], slot: TaskAction['slot']): TaskAction[] {
  return actions.filter((action) => action.slot === slot);
}

/**
 * 头部 `⋯` 与底部 `⋯` 用同一份 `menu` 动作（原型 3.3：同一份按状态生成的动作集），
 * 只额外加「复制任务 ID」——它是纯前端动作，4.9 表里没有位置。
 */
export function headerMenuItems(actions: readonly TaskAction[]): TaskAction[] {
  return pickAction(actions, 'menu');
}
