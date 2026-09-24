import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { defaultRequirementId } from '../quick-create';

/**
 * §19.14·84/86（W2-a 切片 2）：快捷新建的「需求」归属写入口径。
 * - 默认值规则（恰好只选 1 个需求才预选）是纯函数，直钉；
 * - 「分组」字样从本文件可见面整体下线——web 无 jsdom/@testing-library，
 *   用源码扫描兜正向闸（连注释也不留，口径见需求文档 §19.14）。
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

  it('提交体不再直写 group_id——归属字段一律经 requirementCreateBody 成对产出', () => {
    expect(source).not.toMatch(/body\.group_id\s*=/);
    expect(source).toContain('requirementCreateBody');
    expect(source).toContain('parent_task_id');
  });
});
