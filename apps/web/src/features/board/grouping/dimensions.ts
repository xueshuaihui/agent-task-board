import type { TaskCard, TaskStatus } from '@/api/types';
import { STATUS_LABEL, PRIORITY_LABEL } from '@/lib/labels';

/**
 * 7.2 分组维度定义。取值函数只从卡片 DTO 读字段；project / requirement 两维
 * 20.7 的 TaskCard 还没有——先在 GroupableTask 上补可选字段（接缝：
 * 等 board 接口带上 project_id / requirement_* 后删掉本地扩展即可，下游不用改）。
 */
export type GroupDimensionKey =
  | 'project'
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
 * 接缝：`project_id` / `requirement_*` 来自「项目与需求模型」（PRD 五章），
 * 服务端卡片 DTO 尚未下发，先约定字段名，接口补齐后本类型可整体替换为 TaskCard。
 */
export interface GroupableTask extends TaskCard {
  project_id?: string | null;
  project_name?: string | null;
  project_color?: string | null;
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

/** 需求泳道头的元信息行：项目 · 优先级 · 进度。 */
export interface GroupLaneMeta {
  projectName?: string | null;
  projectColor?: string | null;
  priority?: number | null;
  progress?: { done: number; total: number } | null;
}

/** 7.2：未归属需求的任务归入统一泳道。key 用不可能与真实 id 撞车的前缀。 */
export const UNASSIGNED_KEY = '__unassigned__';
export const UNASSIGNED_LABEL = '未归属需求';
/** 「不分组」维度的唯一泳道。 */
export const NONE_KEY = '__none__';
export const NONE_LABEL = '全部任务';
/** 无归属标签/Agent 等的兜底泳道名。 */
export const FALLBACK_LABEL = '未设置';

const single = (key: string, label: string): GroupValue[] => [{ key, label }];

export const GROUP_DIMENSIONS: Record<Exclude<GroupDimensionKey, 'none'>, GroupDimension> = {
  project: {
    key: 'project',
    label: '项目',
    icon: '📁',
    getValues: (task) =>
      task.project_id
        ? single(task.project_id, task.project_name ?? task.project_id)
        : single(UNASSIGNED_KEY, FALLBACK_LABEL),
  },
  requirement: {
    key: 'requirement',
    label: '需求',
    icon: '📋',
    getValues: (task) =>
      task.requirement_id
        ? single(task.requirement_id, task.requirement_title ?? task.requirement_id)
        : single(UNASSIGNED_KEY, UNASSIGNED_LABEL),
    meta: (task) => ({
      projectName: task.requirement_id ? (task.project_name ?? null) : null,
      projectColor: task.project_color ?? null,
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

/** 分组选择器的候选顺序（7.7），「不分组」单独处理。 */
export const GROUPABLE_KEYS = [
  'project',
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
