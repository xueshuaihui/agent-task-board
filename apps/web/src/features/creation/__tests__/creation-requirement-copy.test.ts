import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * §19.14·84（v0.0.4 W2-b 切片 3）：Agent 直建轻确认（卡片 + 编辑弹窗）改需求口径。
 *
 * 已核实的零后端边界（真值在 apps/api/src/creation/creation.dto.ts，简报所指
 * contract 目录仅间接引用）：`creationDecisionSchema.payload` 字段面 =
 * title/description/group_id/type/priority/tags/skills，**没有 parent_task_id**
 * （createTaskSchema 无该键）。所以本片的「需求」下拉只写该需求的 group_id、
 * 不发 parent_task_id——不扩权给 api 加字段。
 *
 * 展示回退逻辑（group_id→需求标题，查不到回 null 兜「未分配」）是纯函数
 * `requirementTitleForGroup`，用例直钉在
 * features/requirements/__tests__/requirement-options.test.ts；这里钉两文件的可见面。
 * UI 未真机验证。
 */

const card = readFileSync(join(__dirname, '..', 'creation-card.tsx'), 'utf8');
const dialog = readFileSync(join(__dirname, '..', 'creation-edit-dialog.tsx'), 'utf8');

describe('creation-card 源码闸：归属展示 =「需求」+ 回退', () => {
  it('展示层零「分组」字样（含 📁 组名渲染退场）', () => {
    expect(card).not.toMatch(/label="分组"/);
    expect(card).not.toMatch(/分组：/);
    expect(card).not.toContain('groupName');
    expect(card).not.toContain('useActiveGroups');
  });

  it('需求标题经 requirementTitleForGroup 反查，查不到兜「未分配」', () => {
    expect(card).toContain('useRequirementOptions');
    expect(card).toContain('requirementTitleForGroup');
    expect(card).toContain('未分配');
  });
});

describe('creation-edit-dialog 源码闸：需求下拉、payload 仍只写 group_id', () => {
  it('Field label 从「分组」改「需求」，候选来自需求 hook', () => {
    expect(dialog).not.toMatch(/label="分组"/);
    expect(dialog).toContain('label="需求"');
    expect(dialog).toContain('useRequirementOptions');
    expect(dialog).not.toContain('useActiveGroups');
  });

  it('零后端约束：decision payload 不发 parent_task_id（字段面没有该键）', () => {
    // 注释允许解释「为什么不发」，但提交体里不得出现该字段。
    expect(dialog).not.toMatch(/^\s*parent_task_id\s*:/m);
    expect(dialog).toMatch(/group_id:\s*groupId/);
  });
});
