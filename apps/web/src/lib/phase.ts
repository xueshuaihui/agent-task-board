/**
 * 17.2 阶段边界开关：阶段二的能力在阶段一「不渲染」，而不是渲染一个点了报错的入口。
 * 后续开阶段二时只翻这里的布尔值，不要在组件里散写 `if (false)`。
 */

/** 依赖图页与 `/dependencies/graph`（5.9 整节后期化）。 */
export const SHOW_DEPENDENCY_GRAPH = false;

/** 通知面板列表（原型 10.2）：阶段一只保留顶栏铃铛 + 未读角标。 */
export const SHOW_NOTIFICATION_PANEL = false;

/** 7.6 自动备份开关（`backup_time` 仍可手动改，但不进阶段一设置页表单）。 */
export const SHOW_AUTO_BACKUP_TOGGLE = false;

/** 6.12.1 导出格式里的 CSV 选项。 */
export const SHOW_CSV_EXPORT = false;

/** 10.3 开机自启：本期无设置项。 */
export const SHOW_LAUNCH_AT_LOGIN = false;
