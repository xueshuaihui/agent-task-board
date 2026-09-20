import type { TaskStatus } from '@/api/types';
import { BOARD_COLUMN_ORDER } from '@/api/types';
import { STATUS_LABEL } from '@/lib/labels';
import {
  NONE_KEY,
  NONE_LABEL,
  dimensionOf,
  type GroupDimensionKey,
  type GroupableTask,
  type GroupLaneMeta,
  type GroupValue,
} from './dimensions';

/**
 * 7.3/7.4 分组引擎（纯函数）：任务集合 + 主分组维度（+ 可选次分组）→ 泳道结构。
 * 泳道 = 主分组值；泳道内列 = 状态六列，开了次分组时先按次分组值再切一层
 * （原型 4.7：分组泳道 × 需求子分组 × 状态列）。
 */

/** 泳道内的一个次分组（无次分组时整条泳道只有一个 label 为 null 的组）。 */
export interface LaneGroup {
  key: string;
  /** null = 未开次分组的平铺列。 */
  label: string | null;
  columns: LaneColumn[];
  count: number;
  reviewCount: number;
}

export interface LaneColumn {
  status: TaskStatus;
  label: string;
  tasks: GroupableTask[];
  count: number;
}

export interface Swimlane {
  key: string;
  label: string;
  icon: string;
  dimension: GroupDimensionKey;
  /** 需求泳道头的元信息行（4.2）：分组 / 优先级 / 进度。 */
  meta: GroupLaneMeta | null;
  count: number;
  reviewCount: number;
  groups: LaneGroup[];
  /**
   * v0.0.4 W4 §6.2.2：泳道头小徽标（「默认」「已归档」）。分组引擎不认识分组实体，
   * 由调用方（GroupedBoard 拿着分组缓存）在泳道构建后填，buildSwimlanes 不产出。
   */
  headBadge?: string;
}

export interface GroupingInput {
  tasks: readonly GroupableTask[];
  primary: GroupDimensionKey;
  secondary?: GroupDimensionKey;
  /** PRD 7.6：空泳道默认隐藏，分组选择器可开（选项「显示空分组」）。 */
  showEmptyLanes?: boolean;
}

interface Bucket {
  key: string;
  label: string;
  meta: GroupLaneMeta | null;
  tasks: GroupableTask[];
}

function bucketize(tasks: readonly GroupableTask[], dimension: GroupDimensionKey): Bucket[] {
  const dim = dimensionOf(dimension);
  const map = new Map<string, Bucket>();
  for (const task of tasks) {
    const values: GroupValue[] = dim
      ? dim.getValues(task)
      : [{ key: NONE_KEY, label: NONE_LABEL }];
    for (const value of values) {
      let bucket = map.get(value.key);
      if (!bucket) {
        bucket = {
          key: value.key,
          label: value.label,
          meta: dim?.meta?.(task) ?? null,
          tasks: [],
        };
        map.set(value.key, bucket);
      }
      bucket.tasks.push(task);
    }
  }
  return [...map.values()];
}

/** 泳道排序：未归属需求永远垫底，其余按当前出现顺序（7.6 的拖拽排序由调用方在结果上重排）。 */
function laneSortKey(bucket: Bucket): number {
  return bucket.key === '__unassigned__' ? 1 : 0;
}

function buildColumns(tasks: readonly GroupableTask[]): LaneColumn[] {
  const byStatus = new Map<TaskStatus, GroupableTask[]>();
  for (const task of tasks) {
    const status = task.status as TaskStatus;
    const list = byStatus.get(status);
    if (list) list.push(task);
    else byStatus.set(status, [task]);
  }
  return BOARD_COLUMN_ORDER.map((status) => {
    const laneTasks = byStatus.get(status) ?? [];
    return {
      status,
      label: STATUS_LABEL[status],
      tasks: laneTasks,
      count: laneTasks.length,
    };
  });
}

function reviewCountOf(tasks: readonly GroupableTask[]): number {
  return tasks.filter((task) => task.status === 'REVIEW').length;
}

/**
 * 主入口。空泳道默认剔除（showEmptyLanes 开启时保留）；可见泳道内的空状态列
 * 仍全部渲染（六列结构固定，PRD 4.1）。
 */
export function buildSwimlanes(input: GroupingInput): Swimlane[] {
  const { tasks, primary, secondary, showEmptyLanes = false } = input;
  const secondaryKey = secondary && secondary !== 'none' && secondary !== primary ? secondary : undefined;

  const lanes = bucketize(tasks, primary)
    .sort((a, b) => laneSortKey(a) - laneSortKey(b))
    .map((bucket): Swimlane => {
      const groups: LaneGroup[] = secondaryKey
        ? bucketize(bucket.tasks, secondaryKey).map((sub) => ({
            key: sub.key,
            label: sub.label,
            columns: buildColumns(sub.tasks),
            count: sub.tasks.length,
            reviewCount: reviewCountOf(sub.tasks),
          }))
        : [
            {
              key: `${bucket.key}:flat`,
              label: null,
              columns: buildColumns(bucket.tasks),
              count: bucket.tasks.length,
              reviewCount: reviewCountOf(bucket.tasks),
            },
          ];
      return {
        key: bucket.key,
        label: bucket.label,
        icon: dimensionOf(primary)?.icon ?? '🗂',
        dimension: primary,
        meta: bucket.meta,
        count: bucket.tasks.length,
        reviewCount: reviewCountOf(bucket.tasks),
        groups,
      };
    });

  const visible = showEmptyLanes ? lanes : lanes.filter((lane) => lane.count > 0);
  // 次分组内的空组永远隐藏（只有次分组值上有卡才出现），空泳道规则独立由 showEmptyLanes 控制。
  return visible.map((lane) => ({ ...lane, groups: lane.groups.filter((group) => group.count > 0) }));
}

/** 7.6 排序：按用户拖出的泳道 key 顺序重排；不在表内的（新出现的泳道）按原顺序垫在后面。 */
export function applyLaneOrder(lanes: readonly Swimlane[], order: readonly string[]): Swimlane[] {
  const rank = new Map(order.map((key, index) => [key, index]));
  return [...lanes].sort(
    (a, b) => (rank.get(a.key) ?? Number.MAX_SAFE_INTEGER) - (rank.get(b.key) ?? Number.MAX_SAFE_INTEGER),
  );
}

/** 7.6 筛选分组：只保留勾选的泳道；空数组 = 不过滤（全部显示）。 */
export function filterLanes(lanes: readonly Swimlane[], selectedKeys: readonly string[]): Swimlane[] {
  if (selectedKeys.length === 0) return [...lanes];
  const allow = new Set(selectedKeys);
  return lanes.filter((lane) => allow.has(lane.key));
}

/** 拖拽结果：跨泳道要改的归属补丁（onChangeGroup 的 patch 由调用方翻译成 API 字段）。 */
export interface GroupMovePatch {
  [field: string]: unknown;
}

/** 7.6 拖拽矩阵：同分组跨列 → 状态流转；跨分组 → 归属变化；跨分组跨列 → 两者都改。 */
export function classifyDrag(input: {
  fromLaneKey: string;
  toLaneKey: string;
  fromStatus: TaskStatus;
  toStatus: TaskStatus;
}): 'none' | 'status' | 'group' | 'group+status' {
  const sameLane = input.fromLaneKey === input.toLaneKey;
  const sameStatus = input.fromStatus === input.toStatus;
  if (sameLane && sameStatus) return 'none';
  if (sameLane) return 'status';
  if (sameStatus) return 'group';
  return 'group+status';
}

/** 把「目标泳道」翻译成归属补丁。接缝：字段名等后端定了以后只改这一个函数。 */
export function patchForLane(input: {
  dimension: GroupDimensionKey;
  laneKey: string;
  task: GroupableTask;
}): GroupMovePatch {
  if (input.dimension === 'requirement') {
    return { requirement_id: input.laneKey === '__unassigned__' ? null : input.laneKey };
  }
  if (input.dimension === 'group') {
    return { group_id: input.laneKey === '__unassigned__' ? null : input.laneKey };
  }
  if (input.dimension === 'tag') {
    return { tag: input.laneKey.startsWith('tag:') ? input.laneKey.slice(4) : input.laneKey };
  }
  if (input.dimension === 'priority') {
    const n = Number(input.laneKey.replace(/^p/, ''));
    return Number.isInteger(n) ? { priority: n } : {};
  }
  if (input.dimension === 'agent') {
    return { agent_name: input.laneKey === '__unassigned__' ? null : input.laneKey };
  }
  if (input.dimension === 'type') {
    return { type: input.laneKey };
  }
  // status 维度不需要归属补丁。
  return {};
}
