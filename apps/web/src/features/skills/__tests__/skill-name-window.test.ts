import { describe, expect, it } from 'vitest';
import type { Skill, SkillContent } from '../types';
import { searchSkills } from '../skill-search';
import { SKILL_CATEGORIES, UNCATEGORIZED_LABEL } from '../meta';
import {
  categoryDisplay,
  pickerRowPlan,
  windowAroundHits,
  PICKER_NAME_BUDGET,
} from '../skill-picker-core';

/**
 * C-6b②/① 纯函数守护：
 * - windowAroundHits：名称过长时以命中位置为中心开窗——命中区间必然落在输出片段内、
 *   输出长度受预算约束、无命中退化为前缀截断；
 * - pickerRowPlan 的 nameBudget 接线（省略 = 全名直出，既有行为不回归）；
 * - categoryDisplay：分类展示与筛选器同源的口径（直读 category 列、'' 走未分类文案、
 *   绝不从 tags 推导）。
 */

const EMPTY_CONTENT: SkillContent = { blocks: [], entryBlockId: null };

function skill(overrides: Partial<Skill> & Pick<Skill, 'id' | 'name'>): Skill {
  return {
    type: 'prompt',
    status: 'PUBLISHED',
    description: '',
    tags: [],
    category: '',
    current_version: 'v1',
    content: EMPTY_CONTENT,
    mcp_dependencies: [],
    source: 'custom',
    readonly: false,
    created_at: '2026-01-01T00:00:00.000Z',
    updated_at: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

const NO_DUP = new Set<string>();

describe('windowAroundHits 命中窗口化', () => {
  it('文本不超预算：原样返回、区间只做合法化裁剪', () => {
    const w = windowAroundHits('周报', [[0, 2]], 24);
    expect(w).toEqual({ text: '周报', ranges: [[0, 2]], truncated: false });
    // 越界区间被裁进文本，不产生非法区间。
    expect(windowAroundHits('周报', [[1, 99]], 24).ranges).toEqual([[1, 2]]);
  });

  it('无命中：退化为前缀截断，两侧只有尾部省略号且长度 ≤ 预算', () => {
    const name = 'boge-kaoyan-writing-coach';
    const w = windowAroundHits(name, [], 24);
    expect(w.text).toBe('boge-kaoyan-writing-coa…');
    expect(w.text.length).toBeLessThanOrEqual(24);
    expect(w.ranges).toEqual([]);
    expect(w.truncated).toBe(true);
  });

  it('命中在尾部（走查案例 financial-analysis-18steps 搜 18steps）：命中段完整落窗、不再被省略号吞掉', () => {
    const name = 'financial-analysis-18steps';
    const ranges: Array<[number, number]> = [[19, 26]];
    const w = windowAroundHits(name, ranges, PICKER_NAME_BUDGET);
    expect(w.text.length).toBeLessThanOrEqual(PICKER_NAME_BUDGET);
    expect(w.truncated).toBe(true);
    expect(w.ranges).toHaveLength(1);
    const [start, end] = w.ranges[0];
    expect(w.text.slice(start, end)).toBe('18steps');
    // 窗口从原文连续片段而来：命中前仍带可辨认的词根语境。
    expect(w.text).toContain('alysis');
    expect(w.text.startsWith('…')).toBe(true);
  });

  it('多段分散命中（子序列档）：每一段都落窗可见、间隙以 … 标记、总长受预算约束', () => {
    const name = 'x'.repeat(60) + 'ACROSS_A_LONG_GAP_TO_FORCE_ELISION' + 'y'.repeat(60) + 'z';
    const ranges: Array<[number, number]> = [
      [0, 5],
      [65, 70],
      [130, 134],
    ];
    const budget = 40;
    const w = windowAroundHits(name, ranges, budget);
    expect(w.text.length).toBeLessThanOrEqual(budget);
    expect(w.ranges).toHaveLength(3);
    // 每段命中都落窗，且区间平移后内容与原文该段逐字相等。
    expect(w.ranges.map(([s, e]) => w.text.slice(s, e))).toEqual(
      ranges.map(([s, e]) => name.slice(s, e)),
    );
  });

  it('多段命中的落窗内容逐段与原文一致（区间平移正确）', () => {
    const name = 'aaaa-BB-cccccc-DD-eeeeee-FF-aaaa';
    const ranges: Array<[number, number]> = [
      [5, 7],
      [15, 17],
    ];
    const w = windowAroundHits(name, ranges, 20);
    expect(w.text.length).toBeLessThanOrEqual(20);
    for (const [start, end] of w.ranges) {
      expect(['BB', 'DD']).toContain(w.text.slice(start, end));
    }
    // 原文内容必然出现在输出里（截断只发生在命中之外的语境）。
    expect(w.text).toContain('BB');
    expect(w.text).toContain('DD');
  });

  it('命中总长本身超预算：从首个命中起点硬开窗，第一段命中仍落窗', () => {
    const name = 'prefix-hit-then-a-very-long-hit-segment-tail';
    const ranges: Array<[number, number]> = [
      [7, 10],
      [20, 45],
    ];
    const w = windowAroundHits(name, ranges, 8);
    expect(w.text.length).toBeLessThanOrEqual(8);
    expect(w.ranges.length).toBeGreaterThanOrEqual(1);
    const first = w.ranges[0];
    expect(w.text.slice(first[0], first[1])).toBe('hit');
    expect(w.truncated).toBe(true);
  });

  it('预算病态值（1 / 非整数）不崩且长度受控', () => {
    expect(windowAroundHits('abcdef', [[2, 4]], 1).text.length).toBeLessThanOrEqual(1);
    expect(windowAroundHits('abcdef', [], 1).text).toBe('…');
    const w = windowAroundHits('abcdefghij', [[0, 2]], 3.7);
    expect(w.text.length).toBeLessThanOrEqual(3);
  });

  it('命中紧贴开头/结尾：该侧不再挂多余省略号', () => {
    const w = windowAroundHits('abcdefghijklmnopqrstuvwxyz', [[0, 3]], 10);
    expect(w.text.startsWith('…')).toBe(false);
    expect(w.text).toContain('abc');
    const tail = windowAroundHits('abcdefghijklmnopqrstuvwxyz', [[23, 26]], 10);
    expect(tail.text.endsWith('…')).toBe(false);
    expect(tail.text).toContain('xyz');
  });
});

describe('pickerRowPlan nameBudget 接线（跑真实 searchSkills 输出）', () => {
  it('省略 nameBudget = 全名直出（既有行为不回归）', () => {
    const target = skill({ id: 'skl_fin001', name: 'financial-analysis-18steps' });
    const hit = searchSkills([target], '18steps')[0];
    const row = pickerRowPlan(hit, NO_DUP);
    expect(row.nameSegments.map((s) => s.text).join('')).toBe(target.name);
    expect(row.nameSegments.filter((s) => s.hit).map((s) => s.text)).toEqual(['18steps']);
  });

  it('给了 nameBudget：分段拼接 = 窗口文本，命中段一定在高亮分段里', () => {
    const target = skill({ id: 'skl_fin001', name: 'financial-analysis-18steps' });
    const hit = searchSkills([target], '18steps')[0];
    const row = pickerRowPlan(hit, NO_DUP, { nameBudget: PICKER_NAME_BUDGET });
    const joined = row.nameSegments.map((s) => s.text).join('');
    expect(joined.length).toBeLessThanOrEqual(PICKER_NAME_BUDGET);
    expect(joined).toContain('18steps');
    expect(row.nameSegments.filter((s) => s.hit).map((s) => s.text)).toEqual(['18steps']);
    // label 仍是全名：title 回显与消歧后缀不受窗口化影响。
    expect(row.label).toBe(target.name);
  });

  it('分组态（空查询、零命中）传预算 → 前缀截断兜底', () => {
    const target = skill({ id: 'skl_boge001', name: 'boge-kaoyan-writing-coach' });
    const row = pickerRowPlan({ skill: target, score: 0, matches: [] }, NO_DUP, { nameBudget: 12 });
    expect(row.nameSegments.map((s) => s.text).join('')).toBe('boge-kaoyan…');
    expect(row.nameSegments.every((s) => !s.hit)).toBe(true);
  });
});

describe('categoryDisplay 分类展示同源（C-6b① 守护）', () => {
  it("'' 走未分类文案，词表值原样直出", () => {
    expect(categoryDisplay(skill({ id: 'a', name: 'x', category: '' }))).toBe(UNCATEGORIZED_LABEL);
    for (const category of SKILL_CATEGORIES) {
      expect(categoryDisplay(skill({ id: 'a', name: 'x', category }))).toBe(category);
    }
  });

  it('分类只读 category 列：tags 里的分类词不参与展示（不从 tags 推导）', () => {
    const target = skill({
      id: 'skl_boge01',
      name: 'boge-kaoyan-writing-coach',
      category: '教育学习',
      tags: ['开学季', '考研'],
    });
    expect(categoryDisplay(target)).toBe('教育学习');
    const uncategorized = skill({ id: 'skl_tag01', name: 'tag-only', category: '', tags: ['教育学习'] });
    expect(categoryDisplay(uncategorized)).toBe(UNCATEGORIZED_LABEL);
  });
});
