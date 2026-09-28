import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * §19.15·91/93④（v0.0.4 r6 R2-B）：归属写入收敛为单字段的源码闸——
 * 四条看板/详情写路径中真实经共享构造器的那三条，其请求体构造处不得出现 `group_id`。
 *
 * 钉的文件（`requirementCreateBody` / `requirementMoveBody` 的消费者）：
 * - features/board/quick-create.tsx —— 快捷新建；
 * - features/board/flow/FlowBoardView.tsx —— 流程图「移到其他需求」/「脱离需求」；
 * - features/task-detail/tabs/overview.tsx —— 详情「所属需求」。
 *
 * §19.15·91 点名的第四条「creation 轻确认编辑」（creation-edit-dialog.tsx）**不经**
 * 上述两个构造器：它写的是 creation decision payload，服务端 `creation.dto.ts` 的
 * 字段面只有 `group_id`、没有 `parent_task_id`（2026-09 核实于
 * apps/api/src/creation/creation.dto.ts 与 apps/web/src/api/types.ts 的
 * CreationDecisionInput）——r6 拍板该下拉**整块删除**（§19.15·91 追加段），
 * R3-C 已落地：下面第二段闸钉它连同 create-task-dialog 的**全文零 group_id**。
 * 给 creation 载荷补 `parent_task_id` 仍属 §19.15·92 的 Agent/REST 面收口范围。
 *
 * 明确**不钉**（读取/分节用途、非写路径，属 R3 范围）：
 * features/board/grouping/dimensions.ts 与 features/task-list/use-group-scoped.ts。
 *
 * 边界注记（§19.15·91）：跨需求移动不再同步搬组，「父在 A 组、子在 B 组」由 UI
 * 常态产生——r6 后 UI 既不按组过滤也不归档组，实测无用户可见后果。保留不动的
 * 最后防线：`buildRequirementOptions` 的归档组剔除与服务端 `assertGroup` 只读守卫。
 *
 * web 无 jsdom/@testing-library，用源码扫描兜组件级断言（口径同 §19.14·84 各闸）。
 */

const FEATURES_DIR = join(__dirname, '..', '..');

const WRITE_PATH_FILES: ReadonlyArray<[string, string]> = [
  ['快捷新建（quick-create）', join('board', 'quick-create.tsx')],
  ['流程图移动（FlowBoardView）', join('board', 'flow', 'FlowBoardView.tsx')],
  ['详情「所属需求」（overview）', join('task-detail', 'tabs', 'overview.tsx')],
];

describe('§19.15·91 写路径源码闸：请求体构造处不出现 group_id', () => {
  for (const [label, rel] of WRITE_PATH_FILES) {
    it(`${label}：全文件（含注释）零 group_id——归属写入只剩 parent_task_id`, () => {
      const source = readFileSync(join(FEATURES_DIR, rel), 'utf8');
      expect(source).not.toContain('group_id');
      expect(source).not.toMatch(/body\.group_id\s*=/);
    });
  }
});

describe('§19.15·90/91 r6 R3-C 闸：两处归属下拉退场后，全文件零 group_id', () => {
  // create-task-dialog 的「分组」下拉并掉后归属只剩「挂到需求」（写 parent_task_id）；
  // creation-edit-dialog 的假归属口整块删除（只提交标题/描述/优先级，见
  // features/creation/__tests__/creation-requirement-copy.test.ts 的字段级闸）。
  const dialogs: ReadonlyArray<[string, string]> = [
    ['新建任务弹窗（create-task-dialog）', join('task-detail', 'create-task-dialog.tsx')],
    ['creation 编辑卡（creation-edit-dialog）', join('creation', 'creation-edit-dialog.tsx')],
  ];

  for (const [label, rel] of dialogs) {
    it(`${label}：全文（含注释）零 group_id / 零 useActiveGroups / 零「分组」归属控件`, () => {
      const source = readFileSync(join(FEATURES_DIR, rel), 'utf8');
      expect(source).not.toContain('group_id');
      expect(source).not.toContain('groupId');
      expect(source).not.toContain('useActiveGroups');
      expect(source).not.toMatch(/label="分组"/);
      expect(source).not.toContain('未分配分组');
    });
  }

  it('create-task-dialog 归属唯一入口 =「挂到需求」写 parent_task_id（§19.15·90「并掉」）', () => {
    const source = readFileSync(join(FEATURES_DIR, 'task-detail', 'create-task-dialog.tsx'), 'utf8');
    expect(source).toMatch(/if \(!asRequirement && parentId\) body\.parent_task_id = parentId;/);
  });
});

describe('§19.15·90 建单归属字段 label 与抽屉同口径：钉死「所属需求」（2026-09-28 走查偏差收口）', () => {
  it('quick-create（快捷新建弹窗）归属字段 label=「所属需求」，不再出现 label=「需求」', () => {
    const source = readFileSync(join(FEATURES_DIR, 'board', 'quick-create.tsx'), 'utf8');
    // 抽屉真值在 task-detail/tabs/overview.tsx 的编辑表单 `label="所属需求"`（§19.15·90「同口径」）。
    expect(source).toContain('label="所属需求"');
    expect(source).not.toMatch(/label="需求"/);
  });

  it('create-task-dialog（新建任务弹窗）不再出现 label=「需求」的裸归属字段', () => {
    const source = readFileSync(join(FEATURES_DIR, 'task-detail', 'create-task-dialog.tsx'), 'utf8');
    expect(source).not.toMatch(/label="需求"/);
  });
});

describe('§19.15·91 构造器函数体闸：requirementCreateBody / requirementMoveBody 不回吐 group_id', () => {
  const hook = readFileSync(join(FEATURES_DIR, 'requirements', 'use-requirement-options.ts'), 'utf8');

  it('两个构造器的实现体（含返回类型）不出现 group_id', () => {
    const createBody = hook.match(/export function requirementCreateBody[\s\S]*?\n}/)?.[0];
    const moveBody = hook.match(/export function requirementMoveBody[\s\S]*?\n}/)?.[0];
    expect(createBody).toBeDefined();
    expect(moveBody).toBeDefined();
    expect(createBody).not.toContain('group_id');
    expect(moveBody).not.toContain('group_id');
  });

  it('候选仍保留 group_id 字段仅供展示反查（requirementTitleForGroup，§19.15·91 保留项）', () => {
    expect(hook).toContain('requirementTitleForGroup');
    expect(hook).toMatch(/interface RequirementOption[\s\S]*?group_id: string \| null;/);
  });
});
