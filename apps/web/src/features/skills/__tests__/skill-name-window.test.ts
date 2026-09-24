import { describe, expect, it } from 'vitest';
import type { Skill, SkillContent } from '../types';
import { searchSkills } from '../skill-search';
import { SKILL_CATEGORIES, UNCATEGORIZED_LABEL } from '../meta';
import {
  categoryDisplay,
  displayWidth,
  nameBudgetFromBoxPx,
  pickerRowNameSegments,
  pickerRowPlan,
  windowAroundHits,
  PICKER_NAME_BUDGET,
  PICKER_NAME_MIN_BUDGET,
  PICKER_NAME_PX_PER_UNIT,
} from '../skill-picker-core';

/**
 * C-6b②/C-6c①②③ 纯函数守护：
 * - windowAroundHits：名称过长时以命中位置为中心开窗——命中区间必然落在输出片段内、
 *   输出**显示宽度**受预算约束（C-6c②：单位从字符数改为显示宽度，拉丁 1 / CJK 2）、
 *   无命中退化为前缀截断（注：选择器渲染层已不再走该分支，见 pickerRowNameSegments）；
 * - displayWidth / nameBudgetFromBoxPx：盒宽→预算的换算与上下限钳制（C-6c②）；
 * - pickerRowNameSegments：零名称命中恒全名直出（C-6c①）、未测到宽退化全名、
 *   实测盒宽下命中必落窗（C-6c②③，走查 CJK 案例回归）；
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

  it('无命中：退化为前缀截断，两侧只有尾部省略号且显示宽度 ≤ 预算', () => {
    const name = 'boge-kaoyan-writing-coach';
    const w = windowAroundHits(name, [], 24);
    // C-6c② 单位改为显示宽度后，省略号按 2 单位计（本字体渲染为全角宽，取保守值），
    // 正文比旧的字符数模型少一个拉丁字符。渲染层已不再走「无命中截断」这条分支
    // （pickerRowNameSegments 零命中恒全名），此处守护的是原语自身的前缀退化语义。
    expect(w.text).toBe('boge-kaoyan-writing-co…');
    expect(displayWidth(w.text)).toBeLessThanOrEqual(24);
    expect(w.ranges).toEqual([]);
    expect(w.truncated).toBe(true);
  });

  it('命中在尾部（走查案例 financial-analysis-18steps 搜 18steps）：命中段完整落窗、不再被省略号吞掉', () => {
    const name = 'financial-analysis-18steps';
    const ranges: Array<[number, number]> = [[19, 26]];
    const w = windowAroundHits(name, ranges, PICKER_NAME_BUDGET);
    expect(displayWidth(w.text)).toBeLessThanOrEqual(PICKER_NAME_BUDGET);
    expect(w.truncated).toBe(true);
    expect(w.ranges).toHaveLength(1);
    const [start, end] = w.ranges[0];
    expect(w.text.slice(start, end)).toBe('18steps');
    // 窗口从原文连续片段而来：命中前仍带可辨认的词根语境。
    // C-6c②：省略号吃 2 单位后语境预算从 7 字符降到 6，可见词根相应少一个头字符。
    expect(w.text).toContain('lysis');
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

describe('displayWidth 显示宽度单位（C-6c②）', () => {
  it('拉丁/数字/半角 1 单位，CJK 与全角标点 2 单位，省略号 … 2 单位', () => {
    expect(displayWidth('18steps')).toBe(7);
    expect(displayWidth('boge-kaoyan-writing-coach')).toBe(25);
    expect(displayWidth('考研数学')).toBe(8);
    expect(displayWidth('，。（）')).toBe(8); // 全角标点
    expect(displayWidth('…')).toBe(2);
    expect(displayWidth('a周1')).toBe(4); // 混排逐码元计
    expect(displayWidth('')).toBe(0);
  });

  it('走查正主案例：20 字 CJK 名宽度 40 > 24 → 字符数模型（20 ≤ 24）漏放的必须截', () => {
    const name = '考研数学极限连续与多元微分综合讲解练习';
    expect(name.length).toBeLessThanOrEqual(PICKER_NAME_BUDGET); // 旧字符数模型：原样吐出（缺陷）
    expect(displayWidth(name)).toBeGreaterThan(PICKER_NAME_BUDGET); // 新单位：超预算，必须开窗
  });
});

describe('nameBudgetFromBoxPx 盒宽→预算换算（C-6c②）', () => {
  it('floor(boxPx / PX_PER_UNIT)，上下钳到 [MIN, PICKER_NAME_BUDGET]', () => {
    expect(nameBudgetFromBoxPx(20 * PICKER_NAME_PX_PER_UNIT)).toBe(20);
    expect(nameBudgetFromBoxPx(20 * PICKER_NAME_PX_PER_UNIT + 7)).toBe(20); // floor：不足一单位舍去
    expect(nameBudgetFromBoxPx(4 * PICKER_NAME_PX_PER_UNIT)).toBe(PICKER_NAME_MIN_BUDGET); // 下限钳制
    expect(nameBudgetFromBoxPx(400)).toBe(PICKER_NAME_BUDGET); // 上限钳制（走查实测 440px 面板盒宽 273px → 封顶 24）
  });
});

describe('CJK 名按显示宽度开窗：命中必落可视预算内（C-6c② 走查回归）', () => {
  it('尾部命中「练习」：窗口显示宽度 ≤ 预算且高亮段完整', () => {
    const name = '考研数学极限连续与多元微分综合讲解练习';
    const at = name.indexOf('练习');
    expect(at).toBeGreaterThan(-1);
    const ranges: Array<[number, number]> = [[at, at + 2]];
    const w = windowAroundHits(name, ranges, nameBudgetFromBoxPx(209));
    expect(w.truncated).toBe(true);
    expect(displayWidth(w.text)).toBeLessThanOrEqual(PICKER_NAME_BUDGET);
    expect(w.ranges.map(([s, e]) => w.text.slice(s, e))).toEqual(['练习']);
  });

  it('多段 CJK 命中 + 逐段平移与原文逐字相等（单位化后不变式仍在）', () => {
    const name = '考研数学' + '—'.repeat(20) + '极限连续' + '—'.repeat(20) + '综合讲解练习';
    const ranges: Array<[number, number]> = [
      [0, 4],
      [24, 28],
      [48, 52],
    ];
    // 预算 60 单位：24（命中宽）+ 8（间隙省略号）放得下，走语境均分档。
    const w = windowAroundHits(name, ranges, 60);
    expect(displayWidth(w.text)).toBeLessThanOrEqual(60);
    expect(w.ranges).toHaveLength(3);
    expect(w.ranges.map(([s, e]) => w.text.slice(s, e))).toEqual(
      ranges.map(([s, e]) => name.slice(s, e)),
    );
  });
});

describe('pickerRowNameSegments 行级窗口接线（跑真实 searchSkills 输出）', () => {
  it('未给盒宽（首帧未测到）= 全名直出 + 命中分段，既有行为不回归', () => {
    const target = skill({ id: 'skl_fin001', name: 'financial-analysis-18steps' });
    const hit = searchSkills([target], '18steps')[0];
    const row = pickerRowPlan(hit, NO_DUP);
    expect(row.nameSegments.map((s) => s.text).join('')).toBe(target.name);
    expect(row.nameSegments.filter((s) => s.hit).map((s) => s.text)).toEqual(['18steps']);
    // nameRanges 原样暴露在全名坐标系上，供渲染层按行实测宽后再开窗。
    expect(row.nameRanges).toEqual(hit.matches.find((m) => m.field === 'name')!.ranges);
    expect(pickerRowNameSegments(row, 0).map((s) => s.text).join('')).toBe(target.name);
  });

  it('给到实测盒宽：分段拼接 = 窗口文本（显示宽度 ≤ 预算），命中段一定在高亮分段里', () => {
    const target = skill({ id: 'skl_fin001', name: 'financial-analysis-18steps' });
    const hit = searchSkills([target], '18steps')[0];
    const row = pickerRowPlan(hit, NO_DUP);
    const segments = pickerRowNameSegments(row, PICKER_NAME_BUDGET * PICKER_NAME_PX_PER_UNIT);
    const joined = segments.map((s) => s.text).join('');
    expect(displayWidth(joined)).toBeLessThanOrEqual(PICKER_NAME_BUDGET);
    expect(joined).toContain('18steps');
    expect(segments.filter((s) => s.hit).map((s) => s.text)).toEqual(['18steps']);
    // label 仍是全名：title 回显与消歧后缀不受窗口化影响。
    expect(row.label).toBe(target.name);
  });

  it('零名称命中恒全名直出：分组态与「命中落在其他字段」都不再窗口化（C-6c①）', () => {
    const target = skill({ id: 'skl_boge001', name: 'boge-kaoyan-writing-coach' });
    // 分组态（空查询、零命中）：预算再小也不截——没有命中要保护，截断是纯损失。
    const grouped = pickerRowPlan({ skill: target, score: 0, matches: [] }, NO_DUP);
    expect(pickerRowNameSegments(grouped, 64).map((s) => s.text).join('')).toBe(target.name);
    // 查询态但命中在分类上（走查案例：搜「分析」命中分类、名称零命中）：名称恒全名。
    const cat = skill({ id: 'skl_fin002', name: 'financial-analysis-18steps', category: '数据分析' });
    const hit = searchSkills([cat], '分析')[0];
    expect(hit.matches.some((m) => m.field === 'category')).toBe(true);
    expect(hit.matches.some((m) => m.field === 'name')).toBe(false);
    const row = pickerRowPlan(hit, NO_DUP);
    const segments = pickerRowNameSegments(row, 64);
    expect(segments.map((s) => s.text).join('')).toBe('financial-analysis-18steps');
    expect(segments.every((s) => !s.hit)).toBe(true);
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
      // tags 里放现行词表词（0925 拍板四已删「开学季」，改用仍在表内的「推荐」）：
      // 它是被服务端 freeTagsOf 剔洗的残留词场景，展示面不许从 tags 长出第二个分类。
      tags: ['推荐', '考研'],
    });
    expect(categoryDisplay(target)).toBe('教育学习');
    const uncategorized = skill({ id: 'skl_tag01', name: 'tag-only', category: '', tags: ['教育学习'] });
    expect(categoryDisplay(uncategorized)).toBe(UNCATEGORIZED_LABEL);
  });
});
