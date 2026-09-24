import { describe, expect, it } from 'vitest';
import { isTopTokenActive, toggleLeafUnderTop, toggleTopToken } from '../skill-category-filter';
import { SKILL_CATEGORY_TREE, leavesOfTopCategory, matchesCategoryTokens } from '../meta';

/**
 * 0925 分类树化 Q5-A 筛选语义守护（纯函数层，无 DOM）：
 * 「选一级 = 该类全部叶子」的收拢、一级与子叶混选去重、多选一级 = 子树叶并集（OR）、
 * 纯分组一级永不直接命中 item.category（命中靠子叶聚合）。
 */

describe('isTopTokenActive / toggleTopToken（一级收拢）', () => {
  it('空选不激活；选中一级 token 或全部子叶单选都算激活（收拢回显）', () => {
    expect(isTopTokenActive([], '编码开发')).toBe(false);
    expect(isTopTokenActive(['需求与规划'], '编码开发')).toBe(false);
    expect(isTopTokenActive(['编码开发'], '编码开发')).toBe(true);
    const allLeaves = leavesOfTopCategory('编码开发').map(String);
    expect(isTopTokenActive(allLeaves, '编码开发')).toBe(true);
    // 一级兼叶子：子树即自身，token 直配。
    expect(isTopTokenActive(['教育学习'], '教育学习')).toBe(true);
    expect(isTopTokenActive(['投资理财'], '教育学习')).toBe(false);
  });

  it('选中一级吸收其子叶的单选 token（混选去重）；再点一级把一级连同子叶一并清掉', () => {
    const after = toggleTopToken(['需求与规划', 'Office办公'], '编码开发');
    expect(after).toEqual(['Office办公', '编码开发']);
    expect(toggleTopToken(after, '编码开发')).toEqual(['Office办公']);
    // 全子叶单选态下点一级 → 同样整组清空。
    const allLeaves = [...leavesOfTopCategory('办公实用')];
    expect(toggleTopToken([...allLeaves, '推荐'], '办公实用')).toEqual(['推荐']);
  });

  it('多选一级 = 各自子树叶子的并集（token 并存互不干扰）', () => {
    const after = toggleTopToken(['编码开发'], '办公实用');
    expect(after).toEqual(['编码开发', '办公实用']);
    expect(matchesCategoryTokens('质量与安全', after)).toBe(true);
    expect(matchesCategoryTokens('实用工具', after)).toBe(true);
    expect(matchesCategoryTokens('教育学习', after)).toBe(false);
  });
});

describe('toggleLeafUnderTop（展开的二级行点选）', () => {
  it('一级整体选中时点某子叶 → 展开为「除它以外的全部子叶」', () => {
    const after = toggleLeafUnderTop(['编码开发'], '编码开发', '质量与安全');
    expect([...after].sort()).toEqual(
      ['需求与规划', '开发与实现', '代码清理', '运维与协作', '测试自动化', '开发编程'].sort(),
    );
    expect(after).not.toContain('质量与安全');
    expect(after).not.toContain('编码开发');
    // 展开后其余子叶仍各自命中（OR 语义未破坏），被点掉的叶子不再命中。
    expect(matchesCategoryTokens('开发编程', after)).toBe(true);
    expect(matchesCategoryTokens('质量与安全', after)).toBe(false);
  });

  it('一级未整体选中时叶子 token 常规增删，与其他一级/叶子 token 并存', () => {
    expect(toggleLeafUnderTop(['教育学习'], '编码开发', '需求与规划')).toEqual([
      '教育学习',
      '需求与规划',
    ]);
    expect(toggleLeafUnderTop(['教育学习', '需求与规划'], '编码开发', '需求与规划')).toEqual([
      '教育学习',
    ]);
  });
});

describe('matchesCategoryTokens（列表过滤命中共用判定）', () => {
  it('token 空集 = 不筛全通过；未分类 \'\' token 直配未分类行', () => {
    for (const top of SKILL_CATEGORY_TREE) {
      for (const leaf of leavesOfTopCategory(top.value)) {
        expect(matchesCategoryTokens(leaf, [])).toBe(true);
      }
    }
    expect(matchesCategoryTokens('', [])).toBe(true);
    expect(matchesCategoryTokens('', [''])).toBe(true);
    expect(matchesCategoryTokens('教育学习', [''])).toBe(false);
  });

  it('纯分组一级 token 永不作为 item.category 出现，命中靠子叶聚合', () => {
    for (const group of ['编码开发', '办公实用', '研究分析']) {
      // 结构前提：分组词不在任何 children 里（不是合法叶子值）；
      // 行为断言：分组 token 不误伤未分类行（parentOfCategory('')=null）。
      expect(SKILL_CATEGORY_TREE.flatMap((top) => [...top.children])).not.toContain(group);
      expect(matchesCategoryTokens('', [group])).toBe(false);
    }
    expect(matchesCategoryTokens('Office办公', ['办公实用'])).toBe(true);
    expect(matchesCategoryTokens('推荐', ['办公实用'])).toBe(false);
    // 一级兼叶子 token 即叶子 token（自身直配）。
    expect(matchesCategoryTokens('方案写作', ['方案写作'])).toBe(true);
  });
});

describe('一级计数含子树全部叶子（筛选栏计数口径的数据层保证）', () => {
  it('7 个一级的子树叶集互斥且并为 16 叶全集', () => {
    const all = SKILL_CATEGORY_TREE.flatMap((top) => [...leavesOfTopCategory(top.value)]);
    expect(all).toHaveLength(16);
    expect(new Set(all).size).toBe(16);
  });
});
