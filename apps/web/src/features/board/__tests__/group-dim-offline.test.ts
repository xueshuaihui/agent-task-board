import { describe, expect, it } from 'vitest';
import { toBoardQuery, type FilterState } from '@/app/store/filters';
import { FILTER_DIMENSIONS } from '../filter/options';

/**
 * §19.14（2026-09-24 拍板）看门口径收口的正向闸：
 * 「分组」与「需求」在看板 UI 是同一概念，Group 实体从看板可见面整体下线，
 * `group_id` 只是数据模型/API 真值——看板侧任何查询构造与筛选词表都不得再出现 groups。
 */

/** 最小可编译的 FilterState 桩（动作字段对本用例无意义，整体 cast 掉）。 */
function stateWith(partial: Partial<FilterState>): FilterState {
  return {
    view: 'all',
    priority: [],
    type: [],
    tags: [],
    groups: [],
    requirements: [],
    agents: [],
    customFields: {},
    status: [],
    keyword: '',
    archived: 'false',
    ...partial,
  } as FilterState;
}

describe('§19.14 看板查询构造：groups 键恒不出现', () => {
  it('store.groups 有残值（列表作用域带过来的）也不进看板查询', () => {
    const query = toBoardQuery(
      stateWith({
        groups: ['g-1', 'none'],
        requirements: ['r-1'],
        priority: [2],
        agents: ['atb'],
        tags: ['t'],
        type: ['Bug'],
      }),
    );
    expect(query).not.toHaveProperty('groups');
    // requirements= 照旧——它才是看板暴露的「分组即需求」维度。
    expect(query.requirements).toEqual(['r-1']);
    expect(query).toMatchObject({ priority: [2], agents: ['atb'], tags: ['t'], type: ['Bug'] });
  });

  it('空筛选同样无 groups 键', () => {
    expect(toBoardQuery(stateWith({}))).not.toHaveProperty('groups');
  });
});

describe('§19.14 看板筛选维度词表：恰为五维', () => {
  it('FILTER_DIMENSIONS = 需求/类型/优先级/Agent/标签，无分组维', () => {
    expect(FILTER_DIMENSIONS.map((dimension) => `${dimension.key}:${dimension.label}`)).toEqual([
      'requirements:需求',
      'type:类型',
      'priority:优先级',
      'agents:Agent',
      'tags:标签',
    ]);
  });
});
