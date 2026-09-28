import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { TaskListItem } from '@/api/types';
import {
  SUBTASK_TYPE,
  aggregateRequirementProgress,
  requirementProgressPercent,
} from '../requirement-progress';

/**
 * §19.15·88 追加段（v0.0.4 r6 · R1a）：需求页行上完成度的**纯聚合层**。
 * web 无 jsdom/@testing-library（口径见 requirement-options.test.ts 头注），
 * 这里只钉纯函数：命中配对 / 需求无子任务 / 子任务超 200 未命中三态，
 * 外加「未命中绝不产出 0/0 猜测值」这条 PRD 原文红线。
 * 页面壳的正向闸走源码扫描（quick-create-requirement.test.ts 同法）。
 */

function requirementRow(id: string): TaskListItem {
  return { id, title: `需求 ${id}`, type: '需求' } as TaskListItem;
}

/** 子卡行：只造 `parent` 摘要（服务端同父恒同值），其余字段与本测试无关。 */
function subtaskRow(
  id: string,
  parent: { id: string; done: number; total: number } | null,
): TaskListItem {
  return { id, title: `子任务 ${id}`, type: SUBTASK_TYPE, parent } as TaskListItem;
}

describe('aggregateRequirementProgress：按 card.parent.id 前端聚合', () => {
  it('正常配对：需求命中子卡 → Map 里有直读的 {done,total}（前端不自行计数）', () => {
    const requirements = [requirementRow('r-1'), requirementRow('r-2')];
    const subtasks = [
      subtaskRow('s-1', { id: 'r-1', done: 2, total: 5 }),
      subtaskRow('s-2', { id: 'r-1', done: 2, total: 5 }),
      subtaskRow('s-3', { id: 'r-2', done: 1, total: 1 }),
    ];
    const map = aggregateRequirementProgress(requirements, subtasks);
    expect(map.get('r-1')).toEqual({ done: 2, total: 5 });
    expect(map.get('r-2')).toEqual({ done: 1, total: 1 });
    // 同父多张子卡只留首个命中，不被后续行覆盖（快照漂移也不猜）。
    expect(aggregateRequirementProgress([requirementRow('r-1')], [...subtasks, subtaskRow('s-9', { id: 'r-1', done: 9, total: 9 })]).get('r-1')).toEqual({ done: 2, total: 5 });
  });

  it('需求无子任务：不进 Map（渲染层整块留空，不显示 0/0）', () => {
    const map = aggregateRequirementProgress([requirementRow('r-empty')], []);
    expect(map.has('r-empty')).toBe(false);
    expect(map.size).toBe(0);
  });

  it('子任务超 200 截断未命中：该需求不进 Map——如实空态，不产猜测值', () => {
    // 模拟 page_size=200 的聚合腿只捞回 r-1 的子卡；r-2 实际有子任务但都不在页内。
    const requirements = [requirementRow('r-1'), requirementRow('r-2')];
    const fetched = [subtaskRow('s-1', { id: 'r-1', done: 3, total: 400 })];
    const map = aggregateRequirementProgress(requirements, fetched);
    expect(map.get('r-1')).toEqual({ done: 3, total: 400 });
    expect(map.has('r-2')).toBe(false);
    // 未命中经百分比函数也只能是 null（整条不渲染），永远不会落成 0。
    expect(requirementProgressPercent(map.get('r-2'))).toBeNull();
  });

  it('parent 缺失或指向不在本页需求行里的父任务 → 跳过，不污染 Map', () => {
    const map = aggregateRequirementProgress(
      [requirementRow('r-1')],
      [
        subtaskRow('s-0', null),
        { id: 's-no-parent-field', title: '游离', type: SUBTASK_TYPE } as TaskListItem,
        subtaskRow('s-x', { id: 'r-other', done: 1, total: 2 }),
      ],
    );
    expect(map.size).toBe(0);
  });
});

describe('requirementProgressPercent：整数百分比、宁 null 不 0', () => {
  it('命中且 total>=1 → 四舍五入百分比（100% 封顶由 Progress 自身钳制）', () => {
    expect(requirementProgressPercent({ done: 2, total: 5 })).toBe(40);
    expect(requirementProgressPercent({ done: 1, total: 3 })).toBe(33);
    expect(requirementProgressPercent({ done: 5, total: 5 })).toBe(100);
  });

  it('未命中（undefined）或 total<=0 → null（整条进度不渲染），绝不是 0', () => {
    expect(requirementProgressPercent(undefined)).toBeNull();
    expect(requirementProgressPercent({ done: 0, total: 0 })).toBeNull();
  });
});

/* ---------------------------------------------------------- 页面源码闸 */

const pageSource = readFileSync(join(__dirname, '..', 'requirements-page.tsx'), 'utf8');

describe('requirements-page.tsx 源码闸（§19.15·88/89 口径的结构化钉）', () => {
  it('「在看板中打开」只写 requirements 维，绝不写 groups 维', () => {
    expect(pageSource).toContain(`setDimension('requirements'`);
    expect(pageSource).not.toContain(`setDimension('groups'`);
  });

  it('创建需求不发 group_id / parent_task_id：对象键形态的这两字段零出现（注释里的字面量不算）', () => {
    expect(pageSource).not.toMatch(/\bgroup_id\s*:/);
    expect(pageSource).not.toMatch(/\bparent_task_id\s*:/);
  });

  it('不引用分组配额（§19.15·89：GROUP_LIMIT 与「x/50」提示都不进本页数据/渲染面）', () => {
    expect(pageSource).not.toContain('GROUP_LIMIT');
    // 配额只可能从 groups 数据层来——本页不 import features/groups 的任何东西
    // （use-requirement-options 的归档剔除走它自己的既有缓存腿，不经页面）。
    expect(pageSource).not.toContain("from '@/features/groups");
    expect(pageSource).not.toMatch(/共 \{[^}]+\}\/\d+/);
  });

  it('聚合腿只服务完成度：type=子任务 + page_size=200，未命中不渲染猜测值', () => {
    expect(pageSource).toContain('SUBTASK_TYPE');
    expect(pageSource).toContain('SUBTASK_FETCH_SIZE = 200');
    // 完成度块以 `progress ?` 条件渲染——未命中即整块缺席，不存在 0/0 兜底分支。
    expect(pageSource).toMatch(/\{progress \? \(/);
  });
});
