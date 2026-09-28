import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { TaskListItem } from '@/api/types';
import {
  aggregateRequirementProgress,
  requirementProgressPercent,
} from '../requirement-progress';

/**
 * §19.15·88 追加段（v0.0.4 r6 · R1a，2026-09-28 定稿口径）：需求页行上完成度的
 * **纯聚合层**。web 无 jsdom/@testing-library（口径见 requirement-options.test.ts 头注），
 * 这里只钉纯函数：命中配对 / 需求无子任务 / 子卡未命中（列截断、归档剔除）三态，
 * 「子任务真值是 parent 不是 type」的配对口径，
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
  type = '子任务',
): TaskListItem {
  return { id, title: `子卡 ${id}`, type, parent } as TaskListItem;
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

  it('子卡未命中（列截断 board_column_limit / 整批落归档组被剔除）：该需求不进 Map——如实空态，不产猜测值', () => {
    // 模拟完成度腿只捞回 r-1 的子卡；r-2 实际有子任务但都不在返回集内。
    const requirements = [requirementRow('r-1'), requirementRow('r-2')];
    const fetched = [subtaskRow('s-1', { id: 'r-1', done: 3, total: 400 })];
    const map = aggregateRequirementProgress(requirements, fetched);
    expect(map.get('r-1')).toEqual({ done: 3, total: 400 });
    expect(map.has('r-2')).toBe(false);
    // 未命中经百分比函数也只能是 null（整条不渲染），永远不会落成 0。
    expect(requirementProgressPercent(map.get('r-2'))).toBeNull();
  });

  it('子任务的真值是 parent_task_id 不是 type：type=缺陷 的子卡照样聚合命中', () => {
    // §19.15·88 改板根因——create-task-dialog 允许「类型=缺陷 + 所属需求=X」建单，
    // 聚合只认 parent 指向，卡片的 type 词表值一律不参与配对。
    const requirements = [requirementRow('r-1')];
    const fetched = [
      subtaskRow('s-bug', { id: 'r-1', done: 1, total: 3 }, '缺陷'),
      subtaskRow('s-refactor', { id: 'r-1', done: 1, total: 3 }, '重构'),
    ];
    const map = aggregateRequirementProgress(requirements, fetched);
    expect(map.get('r-1')).toEqual({ done: 1, total: 3 });
  });

  it('parent 缺失或指向不在本页需求行里的父任务 → 跳过，不污染 Map', () => {
    const map = aggregateRequirementProgress(
      [requirementRow('r-1')],
      [
        subtaskRow('s-0', null),
        { id: 's-no-parent-field', title: '游离', type: '子任务' } as TaskListItem,
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

  it('完成度腿走 GET /board?requirements：只带 requirements、不带 keyword，旧 type=子任务 腿零残留', () => {
    // 数据源形态钉死：useBoard({ view:'all', requirements: ids }, { enabled: ids.length > 0 })。
    const boardCall =
      pageSource.match(/useBoard\(\s*\{[\s\S]*?\},\s*\{[^}]*\},?\s*\)/)?.[0] ?? '';
    expect(boardCall).not.toBe('');
    expect(boardCall).toContain("view: 'all'");
    expect(boardCall).toContain('requirements:');
    // 硬约束②：该腿只带 requirements——搜索词只裁需求列表腿，不能裁完成度来源。
    expect(boardCall).not.toContain('keyword');
    // 旧口径（GET /tasks?type=子任务 聚合腿）已从页面彻底移除。
    expect(pageSource).not.toContain('SUBTASK_TYPE');
    expect(pageSource).not.toContain('SUBTASK_FETCH_SIZE');
    // 列表腿仍且仅仍一条 useTaskList（type=需求）。
    expect(pageSource.match(/useTaskList\(/g)).toHaveLength(1);
    // 完成度块以 `progress ?` 条件渲染——未命中即整块缺席，不存在 0/0 兜底分支。
    expect(pageSource).toMatch(/\{progress \? \(/);
  });

  it('硬约束①：ids 为空必须 enabled:false 不发请求（空 requirements = 全量看板，是错误数据源）', () => {
    // enabled 只能挂在非空判定上：ids.length > 0（或其等价物），且不允许可选参数形态。
    expect(pageSource).toMatch(/enabled:\s*\w+\.length\s*>\s*0/);
    expect(pageSource).not.toMatch(/enabled:\s*true/);
  });
});
