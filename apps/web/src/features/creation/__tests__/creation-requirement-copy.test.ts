import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * §19.14·84 + §19.15·90/91 追加段（v0.0.4 r6 R3-C 改口径）：Agent 直建轻确认的需求口径收口。
 *
 * 卡片展示腿（#5 起）：有 parent_task_id 时按 id 精确反查需求标题；旧请求仍走
 * group_id→需求标题的兼容回退，查不到兜「未分配」/「未知需求」。纯函数
 * `requirementTitleForGroup` 的用例直钉在
 * features/requirements/__tests__/requirement-options.test.ts；这里钉两文件的可见面。
 *
 * 编辑弹窗腿 r6 改板：§19.14 时代的「需求」下拉显示需求标题、写入的却是该需求的
 * `group_id`（当时 decision payload 字段面没有 parent_task_id），是假归属口——r6 拍板
 * **整块删除**。原闸钉的是「下拉存在 + payload 写 group_id」（旧口径），按 93⑥ 改写为
 * 新不变量：编辑卡只提交内容字段与（#5）审核方式，全文零 group_id、零归属下拉；
 * 服务端 payload 虽已接受 parent_task_id（#5），本弹窗仍不提供归属编辑。
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

  it('旧请求仍经 requirementTitleForGroup 反查，查不到兜「未分配」', () => {
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

  it('编辑卡不再提交归属字段：内容字段照旧，onSubmit 载荷里没有 parent_task_id', () => {
    expect(dialog).toContain('label="标题"');
    expect(dialog).toContain('label="描述"');
    expect(dialog).toContain('label="优先级"');
    // 审核方式（#5）另由 creation-review-mode.test.ts 钉；这里只守归属字段不回到提交体。
    expect(dialog).toMatch(/onSubmit\(\{\s*\n\s*title:[\s\S]*?description:[\s\S]*?priority:[\s\S]*?\}\)/);
    expect(dialog).not.toMatch(/^\s*parent_task_id\s*:/m);
    expect(dialog).not.toMatch(/group_id\s*:/);
  });

  it('文案指向真入口：需求归属去任务详情页「所属需求」设', () => {
    expect(dialog).toContain('所属需求');
  });
});
