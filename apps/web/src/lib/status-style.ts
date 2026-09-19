import type { TaskStatus } from '@/api/types';

/**
 * 1.1 状态色 / 优先级色 → Tailwind token 的映射表。
 * 组件里不允许再出现十六进制色值：颜色只从这张表取，改配色只改 styles/globals.css。
 */
export interface StatusStyle {
  /** 状态色点、列头圆点 */
  dot: string;
  /** 浅底（列头计数徽标、卡片左条底色） */
  soft: string;
  /** 状态主色文本 */
  text: string;
  /** 卡片左侧 3px 色条 */
  bar: string;
}

export const STATUS_STYLE: Record<TaskStatus, StatusStyle> = {
  BACKLOG: {
    dot: 'bg-status-backlog',
    soft: 'bg-status-backlog-soft',
    text: 'text-status-backlog',
    bar: 'bg-status-backlog',
  },
  READY: {
    dot: 'bg-status-ready',
    soft: 'bg-status-ready-soft',
    text: 'text-status-ready',
    bar: 'bg-status-ready',
  },
  RUNNING: {
    dot: 'bg-status-running',
    soft: 'bg-status-running-soft',
    text: 'text-status-running',
    bar: 'bg-status-running',
  },
  BLOCKED: {
    dot: 'bg-status-blocked',
    soft: 'bg-status-blocked-soft',
    text: 'text-status-blocked',
    bar: 'bg-status-blocked',
  },
  REVIEW: {
    dot: 'bg-status-review',
    soft: 'bg-status-review-soft',
    text: 'text-status-review',
    bar: 'bg-status-review',
  },
  DONE: {
    dot: 'bg-status-done',
    soft: 'bg-status-done-soft',
    text: 'text-status-done',
    bar: 'bg-status-done',
  },
  FAILED: {
    dot: 'bg-status-failed',
    soft: 'bg-status-failed-soft',
    text: 'text-status-failed',
    bar: 'bg-status-failed',
  },
};

/** 表外状态值的兜底样式：按 20.2 末段渲染为灰色 + 未知（原值）。 */
export const UNKNOWN_STATUS_STYLE: StatusStyle = {
  dot: 'bg-status-blocked',
  soft: 'bg-status-blocked-soft',
  text: 'text-status-blocked',
  bar: 'bg-status-blocked',
};

export function statusStyle(status: string): StatusStyle {
  return STATUS_STYLE[status as TaskStatus] ?? UNKNOWN_STATUS_STYLE;
}

export interface PriorityStyle {
  dot: string;
  soft: string;
  text: string;
}

export const PRIORITY_STYLE: Record<0 | 1 | 2 | 3, PriorityStyle> = {
  0: { dot: 'bg-priority-0', soft: 'bg-priority-0-soft', text: 'text-priority-0' },
  1: { dot: 'bg-priority-1', soft: 'bg-priority-1-soft', text: 'text-priority-1' },
  2: { dot: 'bg-priority-2', soft: 'bg-priority-2-soft', text: 'text-priority-2' },
  3: { dot: 'bg-priority-3', soft: 'bg-priority-3-soft', text: 'text-priority-3' },
};

export const UNKNOWN_PRIORITY_STYLE: PriorityStyle = PRIORITY_STYLE[3];

export function priorityStyle(priority: number): PriorityStyle {
  return PRIORITY_STYLE[priority as 0 | 1 | 2 | 3] ?? UNKNOWN_PRIORITY_STYLE;
}

/** 10.1 状态变更高亮：卡片拿到新数据后加这个类，800ms 后由调用方摘掉。 */
export const FLASH_CLASS = 'animate-status-flash';
