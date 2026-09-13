import type { TaskCard, TaskStatus, Template } from '@/api/types';

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
  remove: (card: TaskCard) => void;
  /** 4.3.1 规则 6：`DONE` 不可逆，重做走「新建任务 + 把原任务设为前置」。 */
  followUp: (card: TaskCard) => void;
  copyId: (card: TaskCard) => void;
  /** 3.4 / 3.1 的创建入口：`template` 只用来预填，落列仍由 `target` 决定。 */
  create: (target: TaskStatus, template?: Template) => void;
}
