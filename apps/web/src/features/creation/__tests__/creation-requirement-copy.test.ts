import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * §19.14·84 + §19.15·90/91 追加段（v0.0.4 r6 R3-C 改口径）：Agent 直建轻确认的需求口径收口。
 *
 * 卡片展示腿不变：group_id→需求标题的反查回退（查不到兜「未分配」）仍是纯函数
 * `requirementTitleForGroup`，用例直钉在
 * features/requirements/__tests__/requirement-options.test.ts；这里钉两文件的可见面。
 *
 * 编辑弹窗腿 r6 改板：§19.14 时代的「需求」下拉显示需求标题、写入的却是该需求的
 * `group_id`（`creation.dto.ts` 的 decision payload 字段面没有 parent_task_id，
 * 真值在 apps/api/src/creation/creation.dto.ts），是假归属口——r6 拍板**整块删除**。
 * 原闸钉的是「下拉存在 + payload 写 group_id」（旧口径），按 93⑥ 改写为新不变量：
 * 编辑卡只提交标题/描述/优先级，全文零 group_id、零归属下拉，也**不许**私加
 * parent_task_id（给 creation 载荷补该字段属服务端改造，另起批，§19.15·92）。
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

describe('creation-edit-dialog 源码闸（r6 新口径）：归属下拉整块退场', () => {
  it('零归属字段：全文不出现 group_id，也不出现需求/分组下拉候选', () => {
    expect(dialog).not.toContain('group_id');
    expect(dialog).not.toContain('groupId');
    expect(dialog).not.toMatch(/label="分组"/);
    expect(dialog).not.toMatch(/label="需求"/);
    expect(dialog).not.toMatch(/label="所属需求"/);
    expect(dialog).not.toContain('creation-edit-requirement');
    // 假归属口的数据源（需求候选反查组）也随之退场——弹窗不再请求需求列表。
    expect(dialog).not.toContain('useRequirementOptions');
    expect(dialog).not.toContain('requirementOptions');
  });

  it('编辑卡只留标题/描述/优先级三字段；提交体不发 parent_task_id（零服务端改动红线）', () => {
    expect(dialog).toContain('label="标题"');
    expect(dialog).toContain('label="描述"');
    expect(dialog).toContain('label="优先级"');
    // onSubmit 载荷字面量恰为三键（注释允许解释「为什么不发」，提交体里不得出现归属字段）。
    expect(dialog).toMatch(/onSubmit\(\{\s*\n\s*title:[\s\S]*?description:[\s\S]*?priority:[\s\S]*?\}\)/);
    expect(dialog).not.toMatch(/^\s*parent_task_id\s*:/m);
    expect(dialog).not.toMatch(/group_id\s*:/);
  });

  it('文案指向真入口：需求归属去任务详情页「所属需求」设', () => {
    expect(dialog).toContain('所属需求');
  });
});
