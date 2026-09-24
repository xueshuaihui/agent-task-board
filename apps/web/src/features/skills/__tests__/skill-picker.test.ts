import { describe, expect, it } from 'vitest';
import type { Skill, SkillContent } from '../types';
import { searchSkills } from '../skill-search';
import {
  buildFlatPlan,
  buildGroupPlan,
  duplicateNameSet,
  highlightSegments,
  pickerRowPlan,
  projectRanges,
} from '../skill-picker-core';

/**
 * D-2 SkillPicker 纯逻辑层测试：分组计划 / 平铺计划 / 高亮切片 / 重名消歧。
 * 关键用例直接跑在真实 searchSkills（D-1）输出上，不 mock 匹配层。
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

const ITEMS: Skill[] = [
  skill({ id: 'skl_code1111', name: '代码评审', type: 'workflow', category: '质量与安全' }),
  skill({ id: 'skl_zhouaa01', name: '周报', category: '方案写作', description: '本周汇总' }),
  skill({ id: 'skl_zhouaa02', name: '周报', category: '', description: '上周汇总' }),
  skill({ id: 'skl_office01', name: '表格汇总', type: 'steps', category: 'Office办公' }),
  skill({ id: 'skl_office02', name: '文档抽取', type: 'script', category: 'Office办公' }),
  skill({ id: 'skl_study001', name: '课后练习', type: 'workflow', category: '教育学习' }),
  skill({ id: 'skl_misc0001', name: '杂项小工具', category: '' }),
  skill({ id: 'skl_misc0002', name: '零散处理', category: '' }),
  // id 高亮窗口用例：全文 id 与后 6 位在 fieldTexts 的拼接串里位置不同。
  skill({ id: 'skl_a1b2c3d4', name: '链接核验', category: '实用工具' }),
];

const NO_DUP = new Set<string>();

describe('duplicateNameSet 重名判定', () => {
  it('只收集出现不止一次的名字', () => {
    const dup = duplicateNameSet(ITEMS);
    expect([...dup].sort()).toEqual(['周报']);
  });

  it('判据是名字集合而非计数，唯一名不进集合', () => {
    expect(duplicateNameSet([skill({ id: 'a', name: '独一份' })])).toEqual(new Set());
  });
});

describe('pickerRowPlan 消歧后缀与展示字段', () => {
  it('重名行带 ·id 后 6 位后缀，唯一名后缀为空串', () => {
    const dup = duplicateNameSet(ITEMS);
    const a = pickerRowPlan({ skill: ITEMS[1], score: 0, matches: [] }, dup);
    const b = pickerRowPlan({ skill: ITEMS[2], score: 0, matches: [] }, dup);
    expect(a.suffix).toBe(' ·ouaa01');
    expect(b.suffix).toBe(' ·ouaa02');
    expect(pickerRowPlan({ skill: ITEMS[0], score: 0, matches: [] }, dup).suffix).toBe('');
    expect(a.label).toBe('周报');
  });

  it('类型行只展示中文标签，绝不把「workflow 工作流」拼接串原样铺出', () => {
    const row = pickerRowPlan({ skill: ITEMS[0], score: 0, matches: [] }, NO_DUP);
    expect(row.typeSegments.map((s) => s.text).join('')).toBe('工作流');
    expect(row.categorySegments.map((s) => s.text).join('')).toBe('质量与安全');
  });

  it('未分类行的分类展示为「未分类」文案', () => {
    const row = pickerRowPlan({ skill: ITEMS[6], score: 0, matches: [] }, NO_DUP);
    expect(row.categorySegments.map((s) => s.text).join('')).toBe('未分类');
  });
});

describe('buildGroupPlan 空查询分组（沿用 SubskillField 观感）', () => {
  it('组头为「分类（条数）」，组大者先、同规模按组名 localeCompare', () => {
    const groups = buildGroupPlan(ITEMS, NO_DUP);
    const titles = groups.map((g) => g.title);
    expect(titles[0]).toBe('Office办公（2）');
    expect(titles[titles.length - 1]).toBe('未分类（3）');
    const middles = titles.slice(1, -1);
    expect(middles).toHaveLength(4);
    expect(middles).toEqual([...middles].sort((a, b) => a.localeCompare(b)));
  });

  it('未分类恒排最后，即使它是最大组', () => {
    const groups = buildGroupPlan(ITEMS, NO_DUP);
    expect(groups[groups.length - 1].key).toBe('');
    expect(groups[groups.length - 1].rows.length).toBe(3);
    // 兜底不过滤：即便按 comparator 未分类不垫底，实现也必须把它挪到最后。
    expect(groups.filter((g) => g.key === '')).toHaveLength(1);
  });

  it('组内按名称稳定序（localeCompare 同名按 id）', () => {
    const groups = buildGroupPlan(ITEMS, NO_DUP);
    const uncategorized = groups[groups.length - 1];
    const names = uncategorized.rows.map((r) => r.label);
    expect(new Set(names)).toEqual(new Set(['周报', '杂项小工具', '零散处理']));
    expect(names).toEqual([...names].sort((a, b) => a.localeCompare(b)));
  });

  it('D-1 空查询返回全量原序，分组计划的行数与之守恒', () => {
    const hits = searchSkills(ITEMS, '');
    expect(hits).toHaveLength(ITEMS.length);
    const total = buildGroupPlan(ITEMS, NO_DUP).reduce((sum, g) => sum + g.rows.length, 0);
    expect(total).toBe(ITEMS.length);
  });
});

describe('buildFlatPlan 查询态平铺（跑在真实 searchSkills 输出上）', () => {
  it('中文查询从分组切到平铺：「办公」子序列命中 Office办公 两条', () => {
    const hits = searchSkills(ITEMS, '办公');
    const flat = buildFlatPlan(hits, NO_DUP, 20);
    expect(flat.total).toBe(2);
    expect(new Set(flat.rows.map((r) => r.label))).toEqual(new Set(['文档抽取', '表格汇总']));
    // score 并列时按 D-1 的 name→id 全序，平铺不再分组。
    expect(flat.truncated).toBe(false);
  });

  it('score 序直通：「周报」两行按 D-1 顺序平铺且都带消歧后缀', () => {
    const hits = searchSkills(ITEMS, '周报');
    const dup = duplicateNameSet(ITEMS);
    const flat = buildFlatPlan(hits, dup, 20);
    expect(flat.rows.map((r) => `${r.label}${r.suffix}`)).toEqual(['周报 ·ouaa01', '周报 ·ouaa02']);
  });

  it('超出 limit 截断并置 truncated，total 保留命中总数', () => {
    const hits = searchSkills(ITEMS, 'o');
    expect(hits.length).toBeGreaterThan(2);
    const flat = buildFlatPlan(hits, NO_DUP, 2);
    expect(flat.rows).toHaveLength(2);
    expect(flat.total).toBe(hits.length);
    expect(flat.truncated).toBe(true);
  });

  it('命中数恰等于 limit 时不出截断提示', () => {
    const hits = searchSkills(ITEMS, '周报');
    const flat = buildFlatPlan(hits, NO_DUP, 2);
    expect(flat.truncated).toBe(false);
  });
});

describe('高亮切片：D-1 matches 投影到真实展示文本', () => {
  it('name 字段命中直接落在展示名上，分段拼接恒等于原文', () => {
    const hits = searchSkills(ITEMS, '评审');
    const row = pickerRowPlan(hits[0], NO_DUP);
    expect(row.nameSegments.filter((s) => s.hit).map((s) => s.text)).toEqual(['评审']);
    expect(row.nameSegments.map((s) => s.text).join('')).toBe('代码评审');
  });

  it('type 中文标签上的命中段可高亮，且英文名段不外泄', () => {
    const hits = searchSkills(ITEMS, '工作流');
    const ids = new Set(hits.map((h) => h.skill.id));
    expect(ids.has('skl_code1111')).toBe(true);
    const row = pickerRowPlan(hits.find((h) => h.skill.id === 'skl_code1111')!, NO_DUP);
    expect(row.typeSegments.filter((s) => s.hit).map((s) => s.text)).toEqual(['工作流']);
    expect(row.typeSegments.map((s) => s.text).join('')).toBe('工作流');
  });

  it('id 拼接串投影到「后 6 位」展示窗口：前文区间被剔除、不越界', () => {
    const target = skill({ id: 'skl_a1b2c3d4', name: '链接核验' });
    // D-1 的 id 待匹配文本是 `skl_a1b2c3d4 b2c3d4`，'a1b2c3' 只落在前文段。
    const hit = searchSkills([target], 'a1b2c3')[0];
    const idMatch = hit.matches.find((m) => m.field === 'id')!;
    expect(idMatch.text).toBe('skl_a1b2c3d4 b2c3d4');
    const suffix = target.id.slice(-6);
    const window: [number, number] = [target.id.length + 1, target.id.length + 1 + suffix.length];
    expect(projectRanges(idMatch.ranges, window[0], window[1])).toEqual([]);
    // 全量越界区间投影进窗口后裁剪为合法段。
    expect(projectRanges([[0, 99]], window[0], window[1])).toEqual([[0, suffix.length]]);
    // highlightSegments 自身兜底：负起点/超界终点裁进展示文本，区间不重叠。
    expect(highlightSegments(suffix, [[-5, 3], [4, 99]])).toEqual([
      { text: 'b2c', hit: true },
      { text: '3', hit: false },
      { text: 'd4', hit: true },
    ]);
  });

  it('id 后 6 位自身的命中投影为完整高亮段', () => {
    const target = skill({ id: 'skl_a1b2c3d4', name: '链接核验' });
    const hit = searchSkills([target], 'b2c3d4')[0];
    const idMatch = hit.matches.find((m) => m.field === 'id')!;
    const suffix = target.id.slice(-6);
    const projected = projectRanges(idMatch.ranges, target.id.length + 1, target.id.length + 1 + suffix.length);
    expect(highlightSegments(suffix, projected)).toEqual([{ text: 'b2c3d4', hit: true }]);
  });

  it('highlightSegments 保持区间不重叠不变式（首尾相接的区间合并成一段）', () => {
    const segments = highlightSegments('abcdef', [
      [0, 2],
      [2, 4],
      [5, 6],
    ]);
    expect(segments).toEqual([
      { text: 'abcd', hit: true },
      { text: 'e', hit: false },
      { text: 'f', hit: true },
    ]);
  });
});
