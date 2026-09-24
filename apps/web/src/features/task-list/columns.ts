import type { ListSortField } from '@/api/types';
import type { TableColumnDef } from '@/components/ui';

/**
 * 3.8 任务列表的**列宽模型**：列宽的唯一真值。
 *
 * 机制（「选筛选项后列宽变化」的根因与解法）见 `ui/table.tsx` 的 `columns` prop：
 * auto 布局按**当前渲染出来的行内容**重算每列，过滤换行集 / colSpan 分节行 /
 * 纵向滚动条 ±15px 都会触发整表重排。fixed 布局下定宽列与内容彻底无关，
 * 剩余宽度全由唯一弹性列（标题）吸收。
 *
 * 地板账（为什么 `TASK_TABLE_MIN_WIDTH` 必须 ≤ 1030）：本页水平外框恒为 250px
 * （侧栏 186 + 内边距），表格容器宽 = 视口宽 − 250。真机实测：1280 视口 → 容器
 * 1030，修复前的 auto 表在这一档能完整放下 11 列且表头零折行、**无横滚**；地板
 * 取 1150 会让这一档平白多出容器内横滚（回归），故地板必须收进 1030。960 档
 * （容器 710）放不下，允许 `.atb-scroll` 容器内横滚兜底，页面级零横滚不变。
 *
 * 逐列取值。参照 = 修复前在同一个 1030 容器里实测的 auto 实渲宽度（20 行全量、
 * 表头 44px 零折行）：[40, 79.7, 228.2, 68.9, 76.8, 91.8, 99.8, 137.2, 59.7, 95.9, 52]。
 * 以下均含 th/td `px-3` 的 24px 内衬：
 * - select 40：16px Checkbox + 24 = 40 即下限，新旧实测均 40，再小裁切勾选框。
 * - id 80：实测 79.7；`T-99999` 等宽 13px 7 字符 ≈ 55 + 24 = 79，更长 IdCell truncate。
 * - title 弹性（保底 220）：唯一弹性列；实测 228.2，保底只在地板档（横滚时）生效，
 *   单行 truncate + Tooltip。
 * - type 72：表头「类型」48；实测 68.9，长类型值 TypeCell truncate。
 * - priority 78：表头「优先级」+ 排序图标 36+4+12+24 = 76（实测 76.8 不折行），
 *   取 78 留 2px 余量防字体度量小数把吸顶表头挤成两行。
 * - status 96：实测 91.8；「人工阻塞」56 + 色点+间距 22 ≈ 96 顶格；租约倒计时/
 *   「已归档」徽标在 StatusCell 的 flex-wrap 里只长行高不动列宽。
 * - tags 112：实测 99.8；封顶 3 个 + `+N`，Badge max-w-full 内层截断，余量 flex-wrap 消化。
 * - agent 112：实测 137.2 是 auto 布局被 Agent 名撑出去推导的，fixed 下不再跟内容；
 *   112 ≈ 14 个拉丁字符完整显示，再长 AgentCell truncate + title 兜底。
 * - duration 64：实测 59.7，表头「时长」48；最长常规形态 `12h 34m` ≈ 66 的异常值
 *   DurationCell truncate 兜底。
 * - updated_at 96：表头「更新时间」+ 排序图标 88；实测 95.9；绝对日期形态
 *   `2026-09-20` 12px 数字 ≈ 96 顶格，再长（未来时钟偏移的完整 datetime）truncate。
 * - actions 52：实测 52 = `iconSm` 按钮 28 + 24，原型 44 装不下内衬，取实测。
 *
 * 定宽合计 802 + 标题保底 220 = 地板 1022 ≤ 1030。
 */

/** 标题列在弹性模型下的保底宽度（参与整表 min-width 的计算）。 */
export const TITLE_MIN_WIDTH = 220;

export interface TaskTableColumn extends TableColumnDef {
  key: 'select' | 'id' | 'title' | 'type' | 'priority' | 'status' | 'tags' | 'agent' | 'duration' | 'updated_at' | 'actions';
  /** 表头文案（select/actions 两列在页面里各有专属渲染，不走这个 label）。 */
  label: string;
  /** 20.3 排序白名单里在本表有列的字段。 */
  sortField?: ListSortField;
}

export const TASK_TABLE_COLUMNS: readonly TaskTableColumn[] = [
  { key: 'select', width: 40, label: '选择' },
  { key: 'id', width: 80, label: 'ID', sortField: 'id' },
  { key: 'title', width: null, label: '标题' },
  { key: 'type', width: 72, label: '类型' },
  { key: 'priority', width: 78, label: '优先级', sortField: 'priority' },
  { key: 'status', width: 96, label: '状态', sortField: 'status' },
  { key: 'tags', width: 112, label: '标签' },
  { key: 'agent', width: 112, label: 'Agent' },
  { key: 'duration', width: 64, label: '时长' },
  { key: 'updated_at', width: 96, label: '更新时间', sortField: 'updated_at' },
  { key: 'actions', width: 52, label: '操作' },
];

/** 定宽列合计（= 除弹性列外的全部列宽之和）。 */
export const TASK_TABLE_FIXED_SUM = TASK_TABLE_COLUMNS.reduce(
  (sum, column) => sum + (column.width ?? 0),
  0,
);

/**
 * 整表地板：定宽列 + 标题保底。低于这个宽度时由外层 `overflow-x-auto` 横滚兜底，
 * 页面本身不整页横滚。地板为何卡在 1030 以内，见文件头「地板账」。
 */
export const TASK_TABLE_MIN_WIDTH = TASK_TABLE_FIXED_SUM + TITLE_MIN_WIDTH;

/**
 * 地板宽度以**字面量 class** 交给 Tailwind 扫描（任意值类必须出现在源码里才会被生成）。
 * `column-widths.test.ts` 断言它与 `TASK_TABLE_MIN_WIDTH` 恒等：改了列宽忘改这里，测试红。
 */
export const TASK_TABLE_MIN_WIDTH_CLASS = 'min-w-[1022px]';
