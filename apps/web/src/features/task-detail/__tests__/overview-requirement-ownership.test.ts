import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * §19.14·84/86（v0.0.4 W2-b 切片 2）：任务详情概览的归属入口收口成「所属需求」。
 *
 * 钉三件事：
 * 1. 可见面零「分组」归属选择——原独立「分组」下拉与 `body.group_id` 裸写全部退场；
 * 2. 归属唯一入口是「所属需求」下拉，写入一律经共享构造器 `requirementMoveBody`
 *    （选中 → 一次 PATCH 原子写 parent_task_id+group_id；未分配 → 仅 parent_task_id:null，
 *    两态形状本身已在 requirements/__tests__/requirement-options.test.ts 直钉）；
 * 3. 有意边界——概览不再提供任何「纯组迁移」入口（需求即组，跨组移动由「换需求」承载）。
 *
 * web 无 jsdom/@testing-library，用源码扫描兜组件级断言（口径同 W2-a 看板闸）。
 * UI 未真机验证。
 */

const source = readFileSync(join(__dirname, '..', 'tabs', 'overview.tsx'), 'utf8');

describe('task-detail overview 源码闸：归属唯一入口 =「所属需求」', () => {
  it('「分组」不再作为归属 label/placeholder 出现（只读行与表单都改「所属需求」口径）', () => {
    expect(source).not.toMatch(/label:\s*'分组'/);
    expect(source).not.toMatch(/label="分组"/);
    expect(source).not.toContain('未分配分组');
    expect(source).toContain("label: '所属需求'");
    expect(source).toContain('label="所属需求"');
    expect(source).toContain('未分配需求');
  });

  it('数据源换 useRequirementOptions，group 候选查表（useActiveGroups）退场', () => {
    expect(source).toContain('useRequirementOptions');
    expect(source).not.toContain('useActiveGroups');
    expect(source).not.toContain('groupOptions');
  });

  it('PATCH 归属只经 requirementMoveBody 成对产出，不再裸写 body.group_id', () => {
    expect(source).toContain('requirementMoveBody');
    expect(source).toMatch(/Object\.assign\(body,\s*requirementMoveBody\(option\)\)/);
    expect(source).not.toMatch(/body\.group_id\s*=/);
    // 「未分配需求」态：requirementId 清空 → option 归 null → requirementMoveBody(null)
    // 只发 parent_task_id:null（构造器两态形状由 requirement-options 测试直钉）。
    expect(source).toMatch(/requirementId\s*===\s*''\s*\|\|\s*option/);
  });
});
