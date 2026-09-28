import type { TaskCard, TaskStatus } from '@/api/types';
import { STATUS_LABEL, PRIORITY_LABEL } from '@/lib/labels';

/**
 * 7.2 分节维度定义（r6 §19.15·90：**`group` 维候选已删**——「分组」概念从 web 可见面
 * 清零，「按需求分节」由本来就在七维内的 `requirement` 维承载；`group_id` 仍是数据模型与
 * REST/Agent 面真值，只是不再作为分节维度暴露）。取值函数只从卡片 DTO 读字段；
 * requirement 维的归属字段 20.7 的 TaskCard 还没有——先在 GroupableTask 上补可选字段
 * （接缝：等 board 接口带上 requirement_* 后删掉本地扩展即可，下游不用改）。
 */
export type GroupDimensionKey =
  | 'requirement'
  | 'type'
  | 'priority'
  | 'agent'
  | 'tag'
  | 'status'
  | 'none';

/** 分组值：key 是泳道身份（排序/折叠/筛选的稳定键），label 是展示名。 */
export interface GroupValue {
  key: string;
  label: string;
}

/**
 * 卡片 + 分组所需的归属字段。
 * 接缝：0919 起 TaskCard 已带 `group_id`（必填 string|null）与 `parent` 摘要
 * （apps/api/src/tasks/task.dto.ts），group_id 直接继承、不再重复声明；
 * 其余展示用扩展字段（group_name / requirement_*）仍由本类型补齐。
 */
export interface GroupableTask extends TaskCard {
  group_name?: string | null;
  group_color?: string | null;
  /** 需求 = 父任务（5.2）：泳道按父任务聚合子任务。 */
  requirement_id?: string | null;
  requirement_title?: string | null;
  /** 需求泳道头进度（4.2）：done / total 由服务端算好下发，前端不算。 */
  requirement_progress?: { done: number; total: number } | null;
}

export interface GroupDimension {
  key: GroupDimensionKey;
  label: string;
  /** 7.5 分组图标。 */
  icon: string;
  /** 一张卡可归属多个分组（标签维），返回空数组表示无归属。 */
  getValues: (task: GroupableTask) => GroupValue[];
  /** 需求泳道头要额外的元信息（4.2 第二行）。 */
  meta?: (task: GroupableTask) => GroupLaneMeta | null;
}

/** 需求泳道头的元信息行：分组 · 优先级 · 进度。 */
export interface GroupLaneMeta {
  groupName?: string | null;
  groupColor?: string | null;
  priority?: number | null;
  progress?: { done: number; total: number } | null;
}

/** 7.2：未归属需求的任务归入统一泳道。key 用不可能与真实 id 撞车的前缀。 */
export const UNASSIGNED_KEY = '__unassigned__';
export const UNASSIGNED_LABEL = '未归属需求';
/** 「不分节」维度的唯一泳道。 */
export const NONE_KEY = '__none__';
export const NONE_LABEL = '全部任务';
/** 无归属标签/Agent 等的兜底泳道名。 */
export const FALLBACK_LABEL = '未设置';

const single = (key: string, label: string): GroupValue[] => [{ key, label }];

export const GROUP_DIMENSIONS: Record<Exclude<GroupDimensionKey, 'none'>, GroupDimension> = {
  requirement: {
    key: 'requirement',
    label: '需求',
    icon: '📋',
    getValues: (task) =>
      task.requirement_id
        ? single(task.requirement_id, task.requirement_title ?? task.requirement_id)
        : single(UNASSIGNED_KEY, UNASSIGNED_LABEL),
    meta: (task) => ({
      groupName: task.requirement_id ? (task.group_name ?? null) : null,
      groupColor: task.group_color ?? null,
      priority: task.priority,
      progress: task.requirement_progress ?? null,
    }),
  },
  type: {
    key: 'type',
    label: '类型',
    icon: '🏷',
    getValues: (task) => single(task.type, task.type),
  },
  priority: {
    key: 'priority',
    label: '优先级',
    icon: '⚡',
    getValues: (task) =>
      single(
        `p${task.priority}`,
        `P${task.priority} ${PRIORITY_LABEL[task.priority as 0 | 1 | 2 | 3] ?? ''}`.trim(),
      ),
  },
  agent: {
    key: 'agent',
    label: 'Agent',
    icon: '🤖',
    getValues: (task) =>
      task.agent_name ? single(task.agent_name, task.agent_name) : single(UNASSIGNED_KEY, FALLBACK_LABEL),
  },
  tag: {
    key: 'tag',
    label: '标签',
    icon: '🏷',
    getValues: (task) =>
      task.tags.length > 0
        ? task.tags.map((tag) => ({ key: `tag:${tag}`, label: tag }))
        : single(UNASSIGNED_KEY, FALLBACK_LABEL),
  },
  status: {
    key: 'status',
    label: '状态',
    icon: '🗂',
    getValues: (task) =>
      single(task.status, STATUS_LABEL[task.status as TaskStatus] ?? task.status),
  },
};

/** 分节维度的候选顺序（7.7；§19.15·90 起不含 group），「不分节」单独处理。 */
export const GROUPABLE_KEYS = [
  'requirement',
  'type',
  'priority',
  'agent',
  'tag',
  'status',
] as const satisfies readonly Exclude<GroupDimensionKey, 'none'>[];

export function dimensionOf(key: GroupDimensionKey): GroupDimension | null {
  return key === 'none' ? null : GROUP_DIMENSIONS[key];
}

/**
 * 20.7 卡片 to GroupableTask：requirement（父任务）摘要在接缝处对齐。
 * 后端 TaskCardDto 带的是 `group_id` 与 `parent { id, title, done, total }`
 * （apps/api/src/tasks/task.dto.ts）；grouping 引擎读的 requirement 系列字段在这里
 * 只做一次翻译。卡片 DTO 直接带这几个字段后可整体删掉本函数。
 * §19.15·90：group 维已删，`group_name` 不再是任何节标题的来源（裸 `group_id` 当标题的
 * 兜底随之退场），这里只把它当存量展示字段翻译给 requirement 维的 lane meta。
 */
export function toGroupable(card: TaskCard): GroupableTask {
  return {
    ...card,
    group_name: card.group_id ?? null,
    requirement_id: card.parent?.id ?? null,
    requirement_title: card.parent?.title ?? null,
    requirement_progress: card.parent ? { done: card.parent.done, total: card.parent.total } : null,
  };
}
