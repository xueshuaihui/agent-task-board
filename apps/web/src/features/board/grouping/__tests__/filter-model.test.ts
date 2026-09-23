import { describe, expect, it } from 'vitest';
import type { GroupableTask } from '../dimensions';
import {
  DEFAULT_BOARD_FILTER_PREFS,
  hasActiveFilter,
  slotStats,
  taskMatchesFilter,
  taskMatchesSlot,
  toggleSlotValue,
} from '../filter-model';

/** B13 分组即过滤：可见性 = 两槽交集、同槽多值 OR、未启用槽恒真。 */
function task(over: Partial<GroupableTask>): GroupableTask {
  return {
    id: Math.random().toString(36).slice(2),
    status: 'READY',
    priority: 2,
    type: '子任务',
    tags: [],
    group_id: null,
    parent: null,
    agent_name: null,
    ...over,
  } as unknown as GroupableTask;
}

const FRONTEND = '01a0cda9-a42a-7760-aede-a1b68876e224';
const BACKEND = '01a0cda9-a440-77cf-bb58-c6c8b9ea150a';

describe('taskMatchesSlot', () => {
  it('未启用（none）或未选值 = 放行', () => {
    const t = task({ group_id: FRONTEND });
    expect(taskMatchesSlot(t, { dim: 'none', values: [] })).toBe(true);
    expect(taskMatchesSlot(t, { dim: 'group', values: [] })).toBe(true);
  });

  it('同槽多值取 OR', () => {
    const slot = { dim: 'group' as const, values: [FRONTEND, BACKEND] };
    expect(taskMatchesSlot(task({ group_id: FRONTEND }), slot)).toBe(true);
    expect(taskMatchesSlot(task({ group_id: BACKEND }), slot)).toBe(true);
    expect(taskMatchesSlot(task({ group_id: null }), slot)).toBe(false);
  });

  it('tag 多值卡：命中任一标签即可见', () => {
    const slot = { dim: 'tag' as const, values: ['tag:看板', 'tag:前端'] };
    expect(taskMatchesSlot(task({ tags: ['体验', '看板'] }), slot)).toBe(true);
    expect(taskMatchesSlot(task({ tags: ['数据'] }), slot)).toBe(false);
  });

  it('requirement 维按父任务 id 匹配，无归属不匹配任何已选值', () => {
    const slot = { dim: 'requirement' as const, values: ['req-1'] };
    expect(taskMatchesSlot(task({ requirement_id: 'req-1' }), slot)).toBe(true);
    expect(taskMatchesSlot(task({ requirement_id: null }), slot)).toBe(false);
  });
});

describe('taskMatchesFilter', () => {
  it('两槽取交集', () => {
    const prefs = {
      slotA: { dim: 'group' as const, values: [FRONTEND] },
      slotB: { dim: 'priority' as const, values: ['p1'] },
    };
    expect(taskMatchesFilter(task({ group_id: FRONTEND, priority: 1 }), prefs)).toBe(true);
    expect(taskMatchesFilter(task({ group_id: FRONTEND, priority: 2 }), prefs)).toBe(false);
    expect(taskMatchesFilter(task({ group_id: BACKEND, priority: 1 }), prefs)).toBe(false);
  });
});

describe('hasActiveFilter / toggleSlotValue', () => {
  it('默认偏好不激活过滤', () => {
    expect(hasActiveFilter(DEFAULT_BOARD_FILTER_PREFS)).toBe(false);
  });
  it('任一槽有值即激活；toggle 增删对称', () => {
    const next = toggleSlotValue([], FRONTEND);
    expect(next).toEqual([FRONTEND]);
    expect(toggleSlotValue(next, FRONTEND)).toEqual([]);
    expect(hasActiveFilter({ slotA: { dim: 'group', values: next }, slotB: { dim: 'none', values: [] } })).toBe(true);
  });
});

describe('slotStats', () => {
  it('计数徽标：总数/执行中/待审核；未归属垫底', () => {
    const tasks = [
      task({ group_id: FRONTEND, status: 'RUNNING' }),
      task({ group_id: FRONTEND, status: 'REVIEW' }),
      task({ group_id: BACKEND }),
      task({ group_id: null }),
    ];
    const stats = slotStats(tasks, 'group');
    const frontend = stats.find((s) => s.key === FRONTEND);
    expect(frontend).toMatchObject({ total: 2, running: 1, review: 1 });
    expect(stats.at(-1)?.key).toBe('__unassigned__');
  });
  it('tag 维一卡多值：各泳道值都计入', () => {
    const stats = slotStats([task({ tags: ['看板', '前端'] })], 'tag');
    expect(stats.find((s) => s.key === 'tag:看板')?.total).toBe(1);
    expect(stats.find((s) => s.key === 'tag:前端')?.total).toBe(1);
  });
});
