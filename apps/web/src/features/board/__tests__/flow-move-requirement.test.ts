import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * §19.14·84 + §19.15·91（r6 改口径）：流程图右键「移到其他需求」写入口径的正向闸。
 * 移动 payload 的两态（选需求只写 parent_task_id / 未分配只置空 parent）
 * 已在 requirements/__tests__/requirement-options.test.ts 直钉 `requirementMoveBody`；
 * 这里钉文件可见面——指 Group 的「分组」字样（含注释）清零，且写入经共享构造器。
 * web 无 jsdom/@testing-library，用源码扫描兜组件级断言（口径同 quick-create 闸）。
 */

const source = readFileSync(join(__dirname, '..', 'flow', 'FlowBoardView.tsx'), 'utf8');

describe('FlowBoardView.tsx 源码闸：移到其他需求、零「分组」字样', () => {
  it('全文件（含注释）零「分组」——Group 概念从流程图可见面整体下线', () => {
    expect(source).not.toContain('分组');
  });

  it('菜单入口文案是「移到其他需求」', () => {
    expect(source).toContain('移到其他需求');
    expect(source).not.toContain('移到其他分组');
  });

  it('数据源换 useRequirementOptions，写入一律经 requirementMoveBody 只写 parent_task_id', () => {
    expect(source).toContain('useRequirementOptions');
    expect(source).toContain('requirementMoveBody');
    expect(source).not.toContain('useActiveGroups');
    // §19.15·91：全文件（含注释）不再出现 group_id——归属回填退场，PATCH 只写 parent_task_id。
    expect(source).not.toContain('group_id');
  });
});
