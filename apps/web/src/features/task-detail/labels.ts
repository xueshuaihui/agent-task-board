import type { TaskTab } from '@/api';
import { COPY } from '@/lib/copy';

/**
 * 抽屉独有的展示文案。跨 feature 的枚举中文表在 `@/lib/labels.ts`，这里只补
 * 「Tab 名 / 预览器提示」这类原型 4.3、6.10 才出现、且没有共享出处的字符串。
 */

/**
 * 抽屉 Tab 名。基座 `TaskTab`（`src/api/types.ts`）不含 0919 追加的「技能」，
 * 本 feature 在本地扩一名（见 tabs/skills.tsx），不改 `src/api`。
 */
export type DrawerTab = TaskTab | 'skills';

export const TAB_LABELS: Record<DrawerTab, string> = {
  overview: '概览',
  runs: '执行',
  reviews: '审核',
  dependencies: '依赖',
  comments: '评论',
  audit: '审计',
  skills: '技能',
};

/** 原型 4.3：只有「执行」与「评论」两项带条数徽标，为 0 时不显示。 */
export const TABS_WITH_COUNT: readonly DrawerTab[] = ['runs', 'comments'];

/**
 * 原型 4.3 的 Tab 顺序。基座 `TASK_TABS`（`src/api/types.ts`）与这里同序同值，
 * 但 `@/api` 只用 `export type * from './types'` 透出**类型**，常量本身取不到值；
 * `src/api/**` 不归本 feature，所以在本地钉一份。TODO(主 agent 接线)：
 * 把 `TASK_TABS` 改成值导出后，这里直接换成 `import { TASK_TABS } from '@/api'`。
 */
export const DRAWER_TABS: readonly DrawerTab[] = [
  'overview',
  'runs',
  'reviews',
  'dependencies',
  'comments',
  'audit',
  'skills',
];

/** 6.10.1 / 13 章：`preview.reason` → 界面文案。 */
export const PREVIEW_REASON_COPY: Record<string, string> = {
  file_missing: COPY.artifactLost,
  renderer_not_in_stage1: '该类型的预览器在阶段二提供（6.10.1）',
};

/** 6.10.3：超过 `artifact_max_mb` 只提供下载。 */
export function previewTooLargeText(maxMb: number): string {
  return `文件过大（超过 ${maxMb} MB 上限），无法预览`;
}

export const TOO_LARGE_HINT = '超过 6.10.3 上限的产物仅提供下载';

export const ARTIFACT_LOST_SHORT = COPY.artifactLost;

/** 4.6 + 6.6：审核 Tab 里「Agent 侧读到什么」的说明行。 */
export const REVIEW_FEEDBACK_NOTE =
  'Agent 下次领取该任务时通过 get_review_feedback 读到以下字段（6.6）';

/** 4.3.1 规则 4：`RUNNING` 不可编辑也不可删，必须先强制停止。 */
export const TASK_RUNNING_EDIT_HINT = '执行中的任务不可编辑，请先强制停止（4.3.1）';

/** 原型 8.2 添加依赖弹窗的类型说明行（5.1 阻塞 vs 关联）。 */
export const COPY_DEPENDENCY_HINT =
  '阻塞：前置未 DONE 时本任务不能开始执行；关联：只做标记，不影响执行顺序（5.1）';
