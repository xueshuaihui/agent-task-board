import type { ListSortField } from '@/api/types';
import type { TableColumnDef } from '@/components/ui';

/**
 * 3.8 任务列表的**列宽模型**：列宽的唯一真值。
 *
 * 为什么要这么改（「选筛选项后列宽变化」的根因）：这张表此前是 `table-layout: auto`
 * 且没有 `<colgroup>`，`th`/`td` 上的 `w-[..]` 在 auto 布局里只是「建议值」——浏览器
 * 按**当前渲染出来的行内容**重算每一列。于是：
 * 1. 任何一次过滤都会换掉可见行集，某列最宽内容一变，整表重排；
 * 2. 分组方式从「无」切到有会插 `colSpan` 分节行，同样参与宽度推导；
 * 3. 筛选 chip 条出现/消失改变页面纵向滚动条有无 → 容器宽度 ±15px → auto 表把这点
 *    差值**摊到所有列**上（实测各列都是 89.2 / 87.2 / 95.3 这类小数，即按比例摊过）。
 * 现在 `Table` 收到 `columns` 后走 `table-layout: fixed` + `<colgroup>`：定宽列与
 * 「渲染了哪些行 / 是否过滤 / 有无纵向滚动条」彻底解耦，剩下的宽度差全部由唯一的
 * 弹性列（标题）吸收。
 *
 * 取值依据（基准 = 主 agent 在 1400px 视口对现网的实测列宽，叠加 th/td 的
 * `px-3`（24px）内衬与表头 `text-aux` 12px / 单元格 `text-body` 14px 的排版账）：
 * - select 40：16px Radix Checkbox（`size-4`）+ 24 = 40；实测勾选列就是 40。
 * - id 90：原型口径；`T-` 短号 13px 等宽约 7.8px/字符，`T-99999` 62 + 24 = 86 ≤ 90；
 *   实测 89.2（= 90 被摊薄后的值），说明内容本来就顶得住 90。
 * - title 弹性（保底 240）：原型口径；整表 `min-w-[960px]` 下其余列合计 910，
 *   所以把表格地板抬到 910 + 240 = 1150（外层 `overflow-x-auto` 横滚兜底，
 *   与现状一致：960px 窗口下这张表今天实际渲染宽度就 ≈1098 且已在容器内横滚）。
 * - type 88：实测 87.2 ≈ 原型 88；长类型值走 `truncate`（TypeCell 已具备）。
 * - priority 80：单元格内容只要 52（色点+`P0`），但表头「优先级」+ 排序图标
 *   3×12 + 4 + 12 + 24 = 76 → 定 80，避免定宽后表头自己先折行。
 * - status 96：实测 95.3 与原型 96 吻合（「人工阻塞」56 + 色点 22 = 78 + 24）；
 *   租约倒计时 / 「已归档」徽标在 StatusCell 的 flex-wrap 里换行，只长行高不动列宽。
 * - tags 160：实测 157.4 ≈ 原型 160；Badge 自带 `max-w-full` + 内层 truncate，
 *   三个封顶 + `+N`，多余宽度由 flex-wrap 消化。
 * - agent 128：原型 104 已被真实数据打穿（实测 137.2，auto 布局把 Agent 名撑了出去）；
 *   定 128 ≈ 14 个 14px 拉丁字符可完整显示，再长走 AgentCell 的 truncate + title 兜底。
 * - duration 72：实测 71.4 = 原型 72；最长形态 `12h 34m`（12px 数字约 42）+ 24 = 66。
 * - updated_at 104：实测 103.6 = 原型 104；表头「更新时间」+ 排序图标 88；
 *   绝对日期兜底形态 `2026-09-20` 约 91；再长（未来时钟偏移出的完整 datetime）truncate。
 * - actions 52：实测 52 = `iconSm` 按钮 28 + 24；原型 44 装不下 24 内衬，取实测。
 */

/** 标题列在弹性模型下的保底宽度（参与整表 min-width 的计算）。 */
export const TITLE_MIN_WIDTH = 240;

export interface TaskTableColumn extends TableColumnDef {
  key: 'select' | 'id' | 'title' | 'type' | 'priority' | 'status' | 'tags' | 'agent' | 'duration' | 'updated_at' | 'actions';
  /** 表头文案（select/actions 两列在页面里各有专属渲染，不走这个 label）。 */
  label: string;
  /** 20.3 排序白名单里在本表有列的字段。 */
  sortField?: ListSortField;
}

export const TASK_TABLE_COLUMNS: readonly TaskTableColumn[] = [
  { key: 'select', width: 40, label: '选择' },
  { key: 'id', width: 90, label: 'ID', sortField: 'id' },
  { key: 'title', width: null, label: '标题' },
  { key: 'type', width: 88, label: '类型' },
  { key: 'priority', width: 80, label: '优先级', sortField: 'priority' },
  { key: 'status', width: 96, label: '状态', sortField: 'status' },
  { key: 'tags', width: 160, label: '标签' },
  { key: 'agent', width: 128, label: 'Agent' },
  { key: 'duration', width: 72, label: '时长' },
  { key: 'updated_at', width: 104, label: '更新时间', sortField: 'updated_at' },
  { key: 'actions', width: 52, label: '操作' },
];

/** 定宽列合计（= 除弹性列外的全部列宽之和）。 */
export const TASK_TABLE_FIXED_SUM = TASK_TABLE_COLUMNS.reduce(
  (sum, column) => sum + (column.width ?? 0),
  0,
);

/**
 * 整表地板：定宽列 + 标题保底。低于这个宽度时由外层 `overflow-x-auto` 横滚兜底，
 * 页面本身不整页横滚（960px 已验收口径的延续，见文件头注释）。
 */
export const TASK_TABLE_MIN_WIDTH = TASK_TABLE_FIXED_SUM + TITLE_MIN_WIDTH;

/**
 * 地板宽度以**字面量 class** 交给 Tailwind 扫描（任意值类必须出现在源码里才会被生成）。
 * `column-widths.test.ts` 断言它与 `TASK_TABLE_MIN_WIDTH` 恒等：改了列宽忘改这里，测试红。
 */
export const TASK_TABLE_MIN_WIDTH_CLASS = 'min-w-[1150px]';
