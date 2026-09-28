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
 * CreationDecisionInput）——收敛它需要 api 侧字段面配合，属 §19.15·92 的 Agent/
 * REST 面收口范围，本闸如实不钉、也不误判 R2 为绿。
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
