import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterAll, describe, expect, it, vi } from 'vitest';
import type { ReactElement, ReactNode } from 'react';
import { TASK_STATUSES } from '@/api/types';
import type { TaskCard, TaskListItem, TaskStatus } from '@/api/types';
import type { MenuGroup, MenuItem } from '@/components/ui';
import type { CardActions } from '../card-actions';

/**
 * 原型 3.8 第 822 行：看板卡片 `⋯` 与任务列表行 `⋯` 必须是**同一份按状态生成的动作集**。
 * 这一片把列表页的第二套 entries 删掉、两处都吃 `cardMenuGroups`（`card-menu.tsx`），
 * 所以这张表对的是「共用的那份菜单」对 4.3/4.5 的符合度——两入口从此同进同退，
 * 一处漏了「删除」就是两处一起漏，这条用例负责在编译期之后再把红灯亮一次。
 *
 * 环境口径同 `board/__tests__/column-always-open.test.ts`：本仓 vitest 无 DOM 环境，
 * 对 `cardMenuGroups` 的**返回值**（id / disabled / danger / onSelect 接线）做断言，
 * 标签里的 ReactNode（置灰项的 Tooltip）用 `renderToStaticMarkup` 取纯文本。
 */

const WEB_SRC = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');

vi.stubGlobal('window', {
  location: { hash: '' },
  addEventListener: () => {},
  removeEventListener: () => {},
  localStorage: { getItem: () => null, setItem: () => {}, removeItem: () => {} },
});
const { cardMenuGroups } = await import('../card-menu');

afterAll(() => {
  vi.unstubAllGlobals();
});

function card(status: TaskStatus, pinned = false): TaskCard {
  return {
    id: 'T-3001',
    title: '两处菜单对表用的任务',
    type: '任务',
    priority: 3,
    tags: [],
    pinned,
    status,
    status_label: status,
    progress: null,
    progress_msg: null,
    lease_expires_at: null,
    agent_name: null,
    run_count: 1,
    due_at: null,
    updated_at: '2026-09-28T10:00:00.000Z',
    blocked: { count: 0, by: [] },
    artifacts: [],
    artifact_count: 0,
    custom_fields: {},
    group_id: null,
    origin_type: 'user',
  };
}

function row(status: TaskStatus, archived: boolean): TaskListItem {
  return { ...card(status), duration_ms: null, started_at: null, archived_at: archived ? '2026-09-28T10:00:00.000Z' : null };
}

type Menu = ReturnType<typeof cardMenuGroups>;

function groupsOf(menu: Menu): MenuGroup[] {
  return menu.filter((entry): entry is MenuGroup => 'items' in entry);
}

/** 按分组名取条目 id（顺序即菜单里的顺序）。 */
function ids(menu: Menu, groupLabel: string): string[] {
  const group = groupsOf(menu).find((entry) => entry.label === groupLabel);
  expect(group, `菜单必须有「${groupLabel}」分组`).toBeDefined();
  return [...(group?.items ?? [])].map((entry) => entry.id);
}

function item(menu: Menu, id: string): MenuItem | undefined {
  for (const group of groupsOf(menu)) {
    const found = group.items.find((entry) => entry.id === id);
    if (found) return found;
  }
  return undefined;
}

function text(label: ReactNode): string {
  return typeof label === 'string' ? label : renderToStaticMarkup(label).replace(/<[^>]*>/g, '').trim();
}

/**
 * 置灰项的原因：Radix Tooltip 的内容只在 hover 后才进 DOM，静态渲染取不到，
 * 所以读 `ReasonTip` 的 `reason` prop——这一项也顺带钉住「禁用必须带说明」而不是只写个 disabled。
 */
function reasonOf(label: ReactNode): string {
  const element = label as ReactElement<{ reason?: string }>;
  expect(element?.props?.reason, '禁用项必须挂 ReasonTip 说明原因').toEqual(expect.any(String));
  return element.props.reason as string;
}

function stubActions(): CardActions & Record<string, ReturnType<typeof vi.fn>> {
  return {
    open: vi.fn(),
    togglePin: vi.fn(),
    move: vi.fn(),
    review: vi.fn(),
    stop: vi.fn(),
    archive: vi.fn(),
    restore: vi.fn(),
    remove: vi.fn(),
    followUp: vi.fn(),
    copyId: vi.fn(),
    create: vi.fn(),
  } as unknown as CardActions & Record<string, ReturnType<typeof vi.fn>>;
}

/**
 * 4.3 操作表 + 4.5 矩阵在 `⋯` 里的逐状态展开（`流转` 组）。
 * `stop` / `review:*` 是 🔒：菜单只给入口，表单在 `StopDialog` 与审核页里提交；
 * `move:ready:disabled` 是把「DONE 不可逆」摆在菜单里，而不是让用户去试。
 */
const FLOW_ITEMS: Record<TaskStatus, string[]> = {
  BACKLOG: ['move:READY'],
  READY: ['move:BACKLOG'],
  RUNNING: ['stop', 'inspect'],
  BLOCKED: ['move:BACKLOG', 'move:READY', 'move:FAILED'],
  REVIEW: ['review:reject', 'review:approve', 'inspect'],
  DONE: ['move:ready:disabled'],
  FAILED: ['move:BACKLOG', 'move:READY', 'inspect'],
};

describe('⋯ 菜单动作集对表（4.3 + 4.5）：卡片与列表行共用这一份', () => {
  it.each(TASK_STATUSES.map((status) => [status] as const))('%s 的流转组条目与顺序', (status) => {
    const groups = cardMenuGroups(card(status), stubActions());
    expect(ids(groups, '流转')).toEqual(FLOW_ITEMS[status]);
  });

  it('元数据组恒为「编辑/查看详情 · 置顶 · 复制 ID」，已完成再多一项「新建后续任务」', () => {
    for (const status of TASK_STATUSES) {
      const groups = cardMenuGroups(card(status), stubActions());
      expect(ids(groups, '卡片')).toEqual(status === 'DONE' ? ['open', 'pin', 'copy', 'follow-up'] : ['open', 'pin', 'copy']);
    }
  });

  it('危险操作组：归档 + 删除恒在，恢复只在归档行多出来（6.13.1）', () => {
    expect(ids(cardMenuGroups(card('DONE'), stubActions()), '危险操作')).toEqual(['archive', 'delete']);
    expect(
      ids(cardMenuGroups(card('DONE'), stubActions(), { archived: true }), '危险操作'),
    ).toEqual(['archive', 'restore', 'delete']);
  });

  it('置灰而不隐藏（原型 3.3 末段）：非 DONE 的归档、RUNNING 的删除、已归档的归档都在菜单里带原因', () => {
    const ready = cardMenuGroups(card('READY'), stubActions());
    expect(item(ready, 'archive')).toMatchObject({ disabled: true });
    expect(text(item(ready, 'archive')!.label)).toBe('归档');
    expect(reasonOf(item(ready, 'archive')!.label)).toContain('6.13.1');

    const running = cardMenuGroups(card('RUNNING'), stubActions());
    expect(item(running, 'delete')).toMatchObject({ disabled: true, danger: true });
    expect(text(item(running, 'delete')!.label)).toBe('删除');
    expect(reasonOf(item(running, 'delete')!.label)).toContain('强制停止');

    // 已归档行的归档项也留在那里说明原因，而不是消失。
    const archived = cardMenuGroups(card('DONE'), stubActions(), { archived: true });
    expect(item(archived, 'archive')).toMatchObject({ disabled: true });
    expect(reasonOf(item(archived, 'archive')!.label)).toContain('恢复');
  });

  it('danger 描红只有三处：强制停止、按失败结案、删除', () => {
    const dangerOf = (status: TaskStatus, id: string) =>
      item(cardMenuGroups(card(status), stubActions()), id)?.danger === true;
    expect(dangerOf('RUNNING', 'stop')).toBe(true);
    expect(dangerOf('BLOCKED', 'move:FAILED')).toBe(true);
    expect(dangerOf('DONE', 'delete')).toBe(true);
    expect(dangerOf('FAILED', 'move:BACKLOG')).toBe(false);
    expect(dangerOf('REVIEW', 'review:approve')).toBe(false);
  });
});

describe('条目接到的是共用动词（列表行与卡片点同一项做同一件事）', () => {
  it('流转 / 危险 / 元数据各项的 onSelect 逐一落到 CardActions 上', () => {
    const actions = stubActions();
    const source = card('BLOCKED');
    const groups = cardMenuGroups(source, actions);
    item(groups, 'move:FAILED')!.onSelect?.();
    expect(actions.move).toHaveBeenLastCalledWith(source, 'FAILED');
    item(groups, 'archive')!.onSelect?.();
    expect(actions.archive).toHaveBeenLastCalledWith(source);
    item(groups, 'delete')!.onSelect?.();
    expect(actions.remove).toHaveBeenLastCalledWith(source);
    item(groups, 'pin')!.onSelect?.();
    expect(actions.togglePin).toHaveBeenLastCalledWith(source);
    item(groups, 'open')!.onSelect?.();
    expect(actions.open).toHaveBeenLastCalledWith(source);
    item(groups, 'copy')!.onSelect?.();
    expect(actions.copyId).toHaveBeenLastCalledWith(source);

    const archivedRow = row('DONE', true);
    item(cardMenuGroups(archivedRow, actions, { archived: true }), 'restore')!.onSelect?.();
    expect(actions.restore).toHaveBeenLastCalledWith(archivedRow);
  });

  it('🔒 的停止与审核只弹表单/跳审核页，不在菜单里发请求', () => {
    const actions = stubActions();
    const running = card('RUNNING');
    item(cardMenuGroups(running, actions), 'stop')!.onSelect?.();
    expect(actions.stop).toHaveBeenCalledWith(running);

    const review = card('REVIEW');
    const groups = cardMenuGroups(review, actions);
    item(groups, 'review:approve')!.onSelect?.();
    item(groups, 'review:reject')!.onSelect?.();
    expect(actions.review).toHaveBeenCalledTimes(2);
    expect(actions.move).not.toHaveBeenCalled();
  });
});

describe('列表页不得再长出第二套动作集', () => {
  const pageSource = readFileSync(join(WEB_SRC, 'features/task-list/index.tsx'), 'utf8');

  it('行菜单读 cardMenuGroups / useCardActions，弹窗与看板同一份组件', () => {
    expect(pageSource).toMatch(/from '@\/features\/board\/card-menu'/);
    expect(pageSource).toMatch(/cardMenuGroups\(/);
    expect(pageSource).toMatch(/useCardActions/);
    for (const name of ['StopDialog', 'DeleteDialog', 'DangerMoveDialog', 'QuickCreateDialog']) {
      expect(pageSource, `${name} 必须在列表页挂载`).toContain(`<${name}`);
    }
  });

  it('没有本页自写的条目、落点表或原生确认框（曾经的第二实现）', () => {
    expect(pageSource).not.toMatch(/allowedTransitions/);
    expect(pageSource).not.toMatch(/window\.confirm\(/);
    expect(pageSource).not.toMatch(/directTransitions\(/);
    expect(pageSource).not.toMatch(/api\.tasks\./);
  });

  it('看板卡片菜单同样只吃这一份：CardMenu 里没有任何自写条目', () => {
    const menuSource = readFileSync(join(WEB_SRC, 'features/board/card-menu.tsx'), 'utf8');
    // 全仓只有 cardMenuGroups 一处生产 ⋯ 条目，两处消费者都调它。
    expect(menuSource).toMatch(/export function cardMenuGroups/);
    expect(menuSource).toMatch(/groups=\{cardMenuGroups\(/);
  });
});
