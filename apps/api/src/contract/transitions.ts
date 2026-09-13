import type { TaskStatus } from './enums';

/**
 * 4.5 拖拽矩阵。
 * direct = ✅ 直接生效；form = 🔒 必须先弹表单（review = 审核/驳回表单，stop = 强制停止确认）；
 * forbidden = ❌ 禁止，reason 决定前端 Toast 文案。
 */
export type TransitionKind =
  | { kind: 'direct' }
  | { kind: 'form'; form: 'review' | 'stop' }
  | { kind: 'forbidden'; reason: 'running-by-agent' | 'done-terminal' | 'self' | 'illegal' };

/** 矩阵里没列出、或明确标 ❌ 的流转：前端按 reason 取 4.5 的 Toast 文案。 */
const ILLEGAL: TransitionKind = { kind: 'forbidden', reason: 'illegal' };

const MATRIX: Record<TaskStatus, Partial<Record<TaskStatus, TransitionKind>>> = {
  BACKLOG: {
    READY: { kind: 'direct' },
    RUNNING: { kind: 'forbidden', reason: 'running-by-agent' },
    REVIEW: ILLEGAL,
    DONE: ILLEGAL,
    FAILED: ILLEGAL,
  },
  READY: {
    BACKLOG: { kind: 'direct' },
    RUNNING: { kind: 'forbidden', reason: 'running-by-agent' },
    REVIEW: ILLEGAL,
    DONE: ILLEGAL,
    FAILED: ILLEGAL,
  },
  RUNNING: {
    BACKLOG: { kind: 'forbidden', reason: 'running-by-agent' },
    READY: { kind: 'forbidden', reason: 'running-by-agent' },
    REVIEW: { kind: 'forbidden', reason: 'running-by-agent' },
    DONE: { kind: 'forbidden', reason: 'running-by-agent' },
    FAILED: { kind: 'form', form: 'stop' },
  },
  REVIEW: {
    BACKLOG: { kind: 'form', form: 'review' },
    READY: { kind: 'form', form: 'review' },
    RUNNING: { kind: 'forbidden', reason: 'running-by-agent' },
    DONE: { kind: 'form', form: 'review' },
    FAILED: ILLEGAL,
  },
  DONE: {
    BACKLOG: { kind: 'forbidden', reason: 'done-terminal' },
    READY: { kind: 'forbidden', reason: 'done-terminal' },
    RUNNING: { kind: 'forbidden', reason: 'done-terminal' },
    REVIEW: { kind: 'forbidden', reason: 'done-terminal' },
    FAILED: { kind: 'forbidden', reason: 'done-terminal' },
  },
  FAILED: {
    BACKLOG: { kind: 'direct' },
    READY: { kind: 'direct' },
    RUNNING: { kind: 'forbidden', reason: 'running-by-agent' },
    REVIEW: ILLEGAL,
    DONE: ILLEGAL,
  },
};

export function classifyTransition(from: TaskStatus, to: TaskStatus): TransitionKind {
  if (from === to) return { kind: 'forbidden', reason: 'self' };
  return MATRIX[from][to] ?? ILLEGAL;
}

/**
 * 「非拖拽」入口（按钮、批量流转）走同一套判定：
 * 只有 direct 与「表单已在别处提交完成」两类可通过 transition 端点。
 * 4.3.1 规则 2：到 RUNNING 一律拒绝，只能由认领事务产生。
 */
export function isDirectTransition(from: TaskStatus, to: TaskStatus): boolean {
  return classifyTransition(from, to).kind === 'direct';
}

/** 审核端点允许的出口：REVIEW → DONE / BACKLOG / READY（4.2）。 */
export const REVIEW_EXIT_TARGETS: TaskStatus[] = ['DONE', 'BACKLOG', 'READY'];
