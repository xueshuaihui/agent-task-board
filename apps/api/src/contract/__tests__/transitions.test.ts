import { describe, expect, it } from 'vitest';
import { TASK_STATUS, type TaskStatus } from '../enums';
import { classifyTransition, REVIEW_EXIT_TARGETS } from '../transitions';

/**
 * 4.5 拖拽矩阵的逐格对照表。按 PRD 表格原样抄一遍（行 = 源，列 = 目标），
 * 这样代码里改了任何一格，这里都会红——矩阵是产品口径，不是实现细节。
 */
type Cell = '—' | '✅' | '❌' | '🔒review' | '🔒stop';

const TARGETS: TaskStatus[] = ['BACKLOG', 'READY', 'RUNNING', 'REVIEW', 'DONE', 'FAILED'];

const MATRIX: Record<TaskStatus, Cell[]> = {
  BACKLOG: ['—', '✅', '❌', '❌', '❌', '❌'],
  READY: ['✅', '—', '❌', '❌', '❌', '❌'],
  RUNNING: ['❌', '❌', '—', '❌', '❌', '🔒stop'],
  REVIEW: ['🔒review', '🔒review', '❌', '—', '🔒review', '❌'],
  DONE: ['❌', '❌', '❌', '❌', '—', '❌'],
  FAILED: ['✅', '✅', '❌', '❌', '❌', '—'],
};

function expected(cell: Cell): string {
  if (cell === '✅') return 'direct';
  if (cell === '🔒review') return 'form:review';
  if (cell === '🔒stop') return 'form:stop';
  return 'forbidden';
}

function actual(from: TaskStatus, to: TaskStatus): string {
  const verdict = classifyTransition(from, to);
  return verdict.kind === 'form' ? `form:${verdict.form}` : verdict.kind;
}

describe('4.5 拖拽矩阵', () => {
  for (const from of TASK_STATUS) {
    it(`${from} 行逐格一致`, () => {
      expect(TARGETS.map((to) => actual(from, to))).toEqual(
        MATRIX[from].map((cell) => expected(cell)),
      );
    });
  }

  it('源 = 目标一律按 self 禁止（前端不落卡、不发请求）', () => {
    for (const status of TASK_STATUS) {
      expect(classifyTransition(status, status)).toEqual({
        kind: 'forbidden',
        reason: 'self',
      });
    }
  });

  it('到 RUNNING 只能是 ❌/🔒，没有任何 direct 入口', () => {
    for (const from of TASK_STATUS) {
      if (from === 'RUNNING') continue;
      expect(actual(from, 'RUNNING')).toBe('forbidden');
    }
  });

  it('已完成是唯一终态行：出边全 ❌，入边只有审核通过与强制停止落点', () => {
    for (const to of TARGETS) {
      if (to !== 'DONE') expect(actual('DONE', to)).toBe('forbidden');
    }
    expect(MATRIX.DONE.filter((cell) => cell === '✅')).toEqual([]);
  });

  it('被阻塞的 READY 不影响人工流转（矩阵与阻塞无关，阻塞只作用于可领取性）', () => {
    expect(actual('READY', 'BACKLOG')).toBe('direct');
    expect(actual('READY', 'FAILED')).toBe('forbidden');
  });

  it('审核出口与 REVIEW 行的 🔒 目标一致', () => {
    const locked = TARGETS.filter(
      (to) => classifyTransition('REVIEW', to).kind === 'form',
    );
    expect(locked.sort()).toEqual([...REVIEW_EXIT_TARGETS].sort());
  });
});
