import { describe, expect, it } from 'vitest';
import type { Skill, SkillContent } from '../types';
import type { SkillFieldMatch } from '../skill-search';
import { searchSkills, tokenizeQuery } from '../skill-search';

/**
 * D-1 匹配算法口径测试：切词 AND、三档强度、六个字段面、打分与确定性排序、高亮区间形状。
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

const FIXTURES: Skill[] = [
  skill({
    id: 'skl_builtin_code-review',
    name: '代码评审 Code Review',
    type: 'prompt',
    category: '质量保障',
    tags: ['code', 'review', '规范'],
    description: '按规范逐行评审代码质量',
  }),
  skill({
    id: 'skl_a1b2c3d4',
    name: 'Excel 表格汇总',
    type: 'steps',
    category: 'Office办公',
    tags: ['表格'],
    description: '多份表格合并汇总',
  }),
  skill({
    id: 'skl_e5f6g7h8',
    name: '文档抽取',
    type: 'script',
    category: 'Office办公',
    tags: ['抽取'],
    description: '从 Office/Word 文档批量抽取文字',
  }),
  skill({
    id: 'skl_b7x9kq2',
    name: '杂项小工具',
    type: 'knowledge',
    category: '',
    tags: ['退款', '工单'],
    description: '处理零散问题',
  }),
  skill({
    id: 'skl_k9l0m1n2',
    name: '课后练习生成',
    type: 'workflow',
    category: '教育学习',
    description: '按知识点出题',
  }),
  skill({ id: 'skl_p0p1p2p3', name: 'Doc 助手', category: '方案写作', description: '写作' }),
  skill({ id: 'skl_q1q2q3q4', name: '我的 doc 工具箱', category: '实用工具', type: 'steps', description: '常用命令' }),
  skill({ id: 'skl_r2r3r4r5', name: 'D 流程 O 节点 C 表', category: '数据分析', type: 'flow', description: '看板式' }),
  skill({ id: 'skl_tieaaa1', name: '周报', category: '方案写作', description: '本周工作汇总' }),
  skill({ id: 'skl_tiebbb2', name: '周报', category: '方案写作', description: '本周工作汇总' }),
];

const hitOf = (query: string, id: string) => searchSkills(FIXTURES, query).find((hit) => hit.skill.id === id);

/** matches 的结构不变式：区间在文本内、非空、升序、互不重叠。 */
function assertWellFormed(matches: SkillFieldMatch[]) {
  for (const match of matches) {
    let previousEnd = -1;
    for (const [start, end] of match.ranges) {
      expect(start).toBeGreaterThanOrEqual(0);
      expect(end).toBeLessThanOrEqual(match.text.length);
      expect(end).toBeGreaterThan(start);
      expect(start).toBeGreaterThanOrEqual(previousEnd);
      previousEnd = end;
    }
  }
}

describe('tokenizeQuery 切词', () => {
  it('按空白切分、去空串、统一小写（半角多空格与换行等价）', () => {
    expect(tokenizeQuery('  Code   quality\n review ')).toEqual(['code', 'quality', 'review']);
  });

  it('全角空格与 NBSP 也是分隔符', () => {
    expect(tokenizeQuery('code　质量')).toEqual(['code', '质量']);
    expect(tokenizeQuery('code 质量')).toEqual(['code', '质量']);
  });

  it('纯空白查询切出空 token 数组', () => {
    expect(tokenizeQuery('  　 ')).toEqual([]);
  });
});

describe('token 之间是 AND', () => {
  it('每个 token 都能命中的技能才留下', () => {
    const hit = hitOf('code 质量', 'skl_builtin_code-review');
    expect(hit).toBeDefined();
    expect(hit!.matches.map((match) => match.field).sort()).toEqual(['category', 'tags']);
  });

  it('任一 token 六面皆空则整条不匹配', () => {
    expect(searchSkills(FIXTURES, 'code 不存在的词')).toEqual([]);
  });

  it('全角空格分隔与半角等价（同一技能同一分）', () => {
    const half = searchSkills(FIXTURES, 'code 质量');
    const full = searchSkills(FIXTURES, 'code　质量');
    expect(full.map((hit) => hit.skill.id)).toEqual(half.map((hit) => hit.skill.id));
    expect(full.map((hit) => hit.score)).toEqual(half.map((hit) => hit.score));
  });
});

describe('三档强度：前缀 > 子串 > 子序列', () => {
  it('子序列命中：ocr 命中描述里的 Office/Word 顺序散字', () => {
    const hit = hitOf('ocr', 'skl_e5f6g7h8');
    expect(hit).toBeDefined();
    expect(hit!.score).toBe(1);
    expect(hit!.matches).toHaveLength(1);
    expect(hit!.matches[0].field).toBe('description');
    expect(hit!.matches[0].ranges).toEqual([
      [2, 3],
      [6, 7],
      [11, 12],
    ]);
    assertWellFormed(hit!.matches);
  });

  it('子序列命中：xl 命中 Excel 名称', () => {
    const hit = hitOf('xl', 'skl_a1b2c3d4');
    expect(hit!.matches[0].field).toBe('name');
    expect(hit!.matches[0].text).toBe('Excel 表格汇总');
    expect(hit!.matches[0].ranges).toEqual([
      [1, 2],
      [4, 5],
    ]);
  });

  it('同字段上前缀分 > 子串分 > 子序列分', () => {
    const hits = searchSkills(FIXTURES, 'doc');
    expect(hits.map((hit) => hit.skill.name)).toEqual(['Doc 助手', '我的 doc 工具箱', 'D 流程 O 节点 C 表']);
    expect(hits.map((hit) => hit.score)).toEqual([9, 6, 3]);
  });
});

describe('六个字段面都能搜到', () => {
  it('名称', () => {
    const hit = hitOf('评审', 'skl_builtin_code-review');
    expect(hit!.matches).toHaveLength(1);
    expect(hit!.matches[0].field).toBe('name');
    expect(hit!.matches[0].ranges).toEqual([[2, 4]]);
  });

  it('描述', () => {
    const hit = hitOf('零散', 'skl_b7x9kq2');
    expect(hit!.matches[0].field).toBe('description');
  });

  it('分类（中文整词子串）', () => {
    const hit = hitOf('教育', 'skl_k9l0m1n2');
    expect(hit!.matches).toHaveLength(1);
    expect(hit!.matches[0].field).toBe('category');
    expect(hit!.matches[0].text).toBe('教育学习');
    expect(hit!.matches[0].ranges).toEqual([[0, 2]]);
    expect(hit!.score).toBe(6);
  });

  it("category 为 '' 时按「未分类」文案命中", () => {
    const hit = hitOf('未分类', 'skl_b7x9kq2');
    expect(hit!.matches).toHaveLength(1);
    expect(hit!.matches[0].field).toBe('category');
    expect(hit!.matches[0].text).toBe('未分类');
  });

  it('类型中文名与英文枚举值都能命中同一字段', () => {
    const zh = hitOf('脚本', 'skl_e5f6g7h8');
    expect(zh!.matches).toHaveLength(1);
    expect(zh!.matches[0].field).toBe('type');
    expect(zh!.matches[0].text).toBe('script 脚本');
    expect(zh!.matches[0].ranges).toEqual([[7, 9]]);
    expect(hitOf('script', 'skl_e5f6g7h8')!.matches[0].field).toBe('type');
    expect(hitOf('工作流', 'skl_k9l0m1n2')!.matches[0].ranges).toEqual([[9, 12]]);
  });

  it('id 与短 ID 后缀（UI 消歧用的后 6 位）', () => {
    expect(hitOf('skl_b7x9kq2', 'skl_b7x9kq2')!.matches[0].field).toBe('id');
    const suffix = hitOf('7x9kq2', 'skl_b7x9kq2');
    expect(suffix!.matches[0].field).toBe('id');
    expect(suffix!.matches[0].text).toBe('skl_b7x9kq2 7x9kq2');
    expect(suffix!.matches[0].ranges).toEqual([
      [5, 11],
      [12, 18],
    ]);
  });

  it('tags', () => {
    const hit = hitOf('退款', 'skl_b7x9kq2');
    expect(hit!.matches[0].field).toBe('tags');
    expect(hit!.matches[0].text).toBe('退款 工单');
  });
});

describe('打分与排序', () => {
  it('总分 = 各 token（最佳档位 × 该档最佳字段权重）之和 / token 数', () => {
    const hit = hitOf('code 质量', 'skl_builtin_code-review');
    // code → tags 前缀 3×2=6；质量 → category 前缀 3×2=6 → (6+6)/2
    expect(hit!.score).toBe(6);
  });

  it('同一 token 只在最高权重字段出高亮（名称 与 描述 同档时取名称）', () => {
    const hit = hitOf('评审', 'skl_builtin_code-review');
    expect(hit!.matches.map((match) => match.field)).toEqual(['name']);
  });

  it('score 降序 → name 升序 → id 升序，完全确定', () => {
    const first = searchSkills(FIXTURES, '周报');
    const second = searchSkills(FIXTURES, '周报');
    expect(second).toEqual(first);
    expect(first.map((hit) => hit.skill.id)).toEqual(['skl_tieaaa1', 'skl_tiebbb2']);

    const wide = searchSkills(FIXTURES, 'o');
    expect(wide.map((hit) => hit.skill.id)).toEqual(searchSkills(FIXTURES, 'o').map((hit) => hit.skill.id));
    for (let i = 1; i < wide.length; i += 1) {
      expect(wide[i - 1].score).toBeGreaterThanOrEqual(wide[i].score);
    }
  });

  it('重名同分按 id 升序（上面 周报 用例即定序结果）', () => {
    const hits = searchSkills(FIXTURES, '周报');
    expect(hits[0].skill.name).toBe(hits[1].skill.name);
    expect(hits[0].score).toBe(hits[1].score);
  });
});

describe('matches 区间', () => {
  it('多 token 命中同字段时区间合并（重叠即并段）', () => {
    const hit = hitOf('exc cel', 'skl_a1b2c3d4');
    expect(hit!.matches).toHaveLength(1);
    expect(hit!.matches[0].field).toBe('name');
    expect(hit!.matches[0].ranges).toEqual([[0, 5]]);
    expect(hit!.score).toBe(7.5);
    assertWellFormed(hit!.matches);
  });

  it('子序列的相邻命中合成一段', () => {
    const hit = hitOf('offe', 'skl_e5f6g7h8');
    expect(hit!.matches).toHaveLength(1);
    expect(hit!.matches[0].field).toBe('category');
    expect(hit!.matches[0].text).toBe('Office办公');
    expect(hit!.matches[0].ranges).toEqual([
      [0, 3],
      [5, 6],
    ]);
    assertWellFormed(hit!.matches);
  });

  it('所有返回的 matches 都满足结构不变式', () => {
    for (const hit of searchSkills(FIXTURES, 'o 表')) assertWellFormed(hit.matches);
  });
});

describe('空查询', () => {
  it('原样返回全部技能：入参顺序、score 0、matches 空', () => {
    const hits = searchSkills(FIXTURES, '  　');
    expect(hits).toHaveLength(FIXTURES.length);
    expect(hits.map((hit) => hit.skill.id)).toEqual(FIXTURES.map((item) => item.id));
    for (const hit of hits) {
      expect(hit.score).toBe(0);
      expect(hit.matches).toEqual([]);
    }
  });
});
