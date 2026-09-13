import type { ReactElement, ReactNode } from 'react';
import {
  Archive,
  ClipboardList,
  Copy,
  Ellipsis,
  Eye,
  Pin,
  Plus,
  RotateCw,
  Square,
  SquarePen,
  Trash2,
} from 'lucide-react';
import type { TaskCard, TaskStatus } from '@/api/types';
import { COPY } from '@/lib/copy';
import { STATUS_LABEL } from '@/lib/labels';
import { IconButton, Menu, Tooltip, type MenuItem, type MenuGroup } from '@/components/ui';
import { COLUMN_ORDER, knownStatus } from './model';
import { dropVerdict, FORM_ACTION } from './matrix';
import type { CardActions } from './card-actions';

/**
 * 4.3 操作表 + 原型 3.3「`⋯` 菜单项随状态变化」：**与拖拽共用 `dropVerdict`**，
 * 菜单不自立一套流转规则（原型 3.8 末段对列表页提的是同一条要求）。
 * ✅ 项的动作名直接取判定里的 `rule.menuLabel`（矩阵的 `DIRECT_TRANSITIONS`），
 * 详情抽屉的按钮读的是同一张表的 `rule.label`——两处只会同时跟着矩阵变。
 *
 * 置灰而不隐藏（原型 3.3 末段）：归档只对 `DONE` 开放、删除对 `RUNNING` 关闭，
 * 隐藏会让人以为功能丢了；原因用 Tooltip 给，文案取 4.5 统一文案表。
 */
export function CardMenu({ card, actions }: { card: TaskCard; actions: CardActions }) {
  return (
    <Menu
      align="end"
      width={220}
      groups={cardMenuGroups(card, actions)}
      trigger={({ open, toggle }) => (
        <IconButton
          label="更多操作"
          size="iconSm"
          className="size-6"
          aria-expanded={open}
          icon={<Ellipsis className="size-3.5" />}
          onClick={toggle}
        />
      )}
    />
  );
}

/** 单独导出：列表页接线时（3.8「同一份按状态生成的动作集」）可直接复用。 */
export function cardMenuGroups(card: TaskCard, actions: CardActions): (MenuItem | MenuGroup)[] {
  const status = knownStatus(card.status);
  const groups: MenuGroup[] = [];

  const flow = status ? flowItems(card, status, actions) : [];
  if (flow.length > 0) groups.push({ label: '流转', items: flow });

  const meta: MenuItem[] = [
    {
      id: 'open',
      label: '编辑 / 查看详情',
      icon: <SquarePen className="size-3.5" />,
      onSelect: () => actions.open(card),
    },
    {
      id: 'pin',
      label: card.pinned ? '取消置顶' : '置顶',
      icon: <Pin className="size-3.5" />,
      // 7.2 的键盘入口挂在卡片上（`board-card.tsx`），菜单里点出来才有地方可查。
      hint: '⌘/Ctrl + P',
      onSelect: () => actions.togglePin(card),
    },
    {
      id: 'copy',
      label: '复制 ID',
      icon: <Copy className="size-3.5" />,
      onSelect: () => actions.copyId(card),
    },
  ];
  if (status === 'DONE') {
    // 4.3.1 规则 6：需要重做请新建任务并把原任务设为前置，保留可追溯的因果链。
    meta.push({
      id: 'follow-up',
      label: '新建后续任务',
      icon: <Plus className="size-3.5" />,
      hint: '保留因果链',
      onSelect: () => actions.followUp(card),
    });
  }
  groups.push({ label: '卡片', items: meta });

  groups.push({ label: '危险操作', items: dangerItems(card, status, actions) });

  return groups;
}

function flowItems(card: TaskCard, status: TaskStatus, actions: CardActions): MenuItem[] {
  const items: MenuItem[] = [];
  for (const to of COLUMN_ORDER) {
    if (to === status) continue;
    const verdict = dropVerdict(status, to);
    if (verdict.kind === 'direct') {
      items.push({
        id: `move:${to}`,
        label: verdict.rule.menuLabel,
        icon: <RotateCw className="size-3.5" />,
        onSelect: () => actions.move(card, to),
      });
      continue;
    }
    if (verdict.kind === 'form' && verdict.form === 'stop') {
      items.push({
        id: 'stop',
        // 动作名与矩阵那一格（= 3.7 列头徽标）同源，不在此处重复字面量。
        label: FORM_ACTION.stop,
        icon: <Square className="size-3.5" />,
        danger: true,
        hint: '仅吊销租约',
        onSelect: () => actions.stop(card),
      });
      continue;
    }
    if (verdict.kind === 'form' && verdict.form === 'review') {
      // 通过/驳回都在 720px 审核表单里提交（4.3.1 规则 5）；退回目标由表单选择。
      if (to === 'DONE') {
        items.push({
          id: 'review:approve',
          label: '审核通过…',
          icon: <ClipboardList className="size-3.5" />,
          onSelect: () => actions.review(card),
        });
      } else if (to === 'READY') {
        items.push({
          id: 'review:reject',
          label: '驳回 / 退回重跑…',
          icon: <ClipboardList className="size-3.5" />,
          hint: '选退回目标',
          onSelect: () => actions.review(card),
        });
      }
      continue;
    }
    if (status === 'DONE' && to === 'READY') {
      // 把「DONE 不可逆」摆在菜单里，而不是让用户去试（原型 3.3：已完成无任何退回）。
      items.push({
        id: 'move:ready:disabled',
        label: <ReasonTip reason={COPY.dragOutOfDone}>退回待执行</ReasonTip>,
        icon: <RotateCw className="size-3.5" />,
        disabled: true,
      });
    }
  }
  const inspect = inspectItem(card, status, actions);
  if (inspect) items.push(inspect);
  return items;
}

function dangerItems(card: TaskCard, status: TaskStatus | null, actions: CardActions): MenuItem[] {
  return [
    {
      id: 'archive',
      label: status === 'DONE' ? '归档' : <ReasonTip reason="归档只对已完成的任务开放（6.13.1）">归档</ReasonTip>,
      icon: <Archive className="size-3.5" />,
      disabled: status !== 'DONE',
      onSelect: () => actions.archive(card),
    },
    {
      id: 'delete',
      label:
        status === 'RUNNING' ? (
          <ReasonTip reason="执行中的任务请先强制停止（4.3.1 规则 4）">删除</ReasonTip>
        ) : (
          '删除'
        ),
      icon: <Trash2 className="size-3.5" />,
      danger: true,
      disabled: status === 'RUNNING',
      onSelect: () => actions.remove(card),
    },
  ];
}

function inspectItem(card: TaskCard, status: TaskStatus | null, actions: CardActions): MenuItem | null {
  const labels: Partial<Record<TaskStatus, string>> = {
    RUNNING: '查看执行',
    REVIEW: '查看产物',
    FAILED: '查看失败原因',
  };
  const text = status ? labels[status] : undefined;
  if (!text || !status) return null;
  return {
    id: 'inspect',
    label: (
      <Tooltip content={`${card.id} · ${STATUS_LABEL[status]}`}>
        <span className="truncate">{text}</span>
      </Tooltip>
    ),
    icon: <Eye className="size-3.5" />,
    onSelect: () => actions.open(card),
  };
}

/** 禁用项的说明：`MenuItem.label` 收 ReactNode，就地塞一个 Tooltip 就够，不再自造控件。 */
function ReasonTip({ reason, children }: { reason: string; children: ReactNode }): ReactElement {
  return (
    <Tooltip content={reason}>
      <span className="truncate">{children}</span>
    </Tooltip>
  );
}
