import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { defaultRequirementId } from '../quick-create';

/**
 * §19.14·84 + §19.15·91（r6 改口径）：快捷新建的「需求」归属写入口径。
 * - 默认值规则（恰好只选 1 个需求才预选）是纯函数，直钉；
 * - 「分组」字样从本文件可见面整体下线——web 无 jsdom/@testing-library，
 *   用源码扫描兜正向闸（连注释也不留，口径见需求文档 §19.14·84）。
 */

const source = readFileSync(join(__dirname, '..', 'quick-create.tsx'), 'utf8');

describe('defaultRequirementId：看板需求筛选恰好只选 1 个时默认挂该需求', () => {
  it('单选 1 个需求 → 默认值即该需求 id', () => {
    expect(defaultRequirementId(['r-1'])).toBe('r-1');
  });

  it('未选 / 多选 → 不预选（归属是弱约束，不替用户做主）', () => {
    expect(defaultRequirementId([])).toBe('');
    expect(defaultRequirementId(['r-1', 'r-2'])).toBe('');
  });
});

describe('quick-create.tsx 源码闸：指 Group 的「分组」字样不再出现', () => {
  it('全文件（含注释）零「分组」', () => {
    expect(source).not.toContain('分组');
  });

  it('提交体不出现 group_id（§19.15·91）——归属经 requirementCreateBody 只写 parent_task_id', () => {
    expect(source).not.toContain('group_id');
    expect(source).not.toMatch(/body\.group_id\s*=/);
    expect(source).toContain('requirementCreateBody');
    expect(source).toContain('parent_task_id');
  });
});

/**
 * 10.2 创建即绑定：候选区必须是共享 SkillPicker（§19.13-83 的「同一个组件」口径），
 * 且引用只带 skill_id——版本由服务端补（与详情「技能」Tab 同一口径，前端不猜版本）。
 */
describe('quick-create.tsx 源码闸：技能随创建提交', () => {
  it('候选区用共享 SkillPickerPopover（多选），不是自绘搜索框', () => {
    expect(source).toContain('SkillPickerPopover');
    expect(source).toMatch(/<SkillPickerPopover[\s\S]*?multiple/);
  });

  it('提交体只传 skill_id、不传版本', () => {
    expect(source).toMatch(/body\.skills\s*=\s*skillIds\.map\(\(skill_id\)\s*=>\s*\(\{\s*skill_id\s*\}\)/);
  });
});
