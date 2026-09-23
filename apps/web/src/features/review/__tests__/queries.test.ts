import { describe, expect, it } from 'vitest';
import type { RunArtifact, TaskRun } from '@/api/types';
import { artifactsSourceRun, reviewTargetRun } from '../queries';

/** beta.6 B8：审核弹窗的产物回退——目标 Run 无产物时取最近一次有产物的 Run。 */

const artifact = (id: string): RunArtifact => ({
  id,
  type: 'text',
  name: `${id}.md`,
  size_bytes: 10,
  mime_type: 'text/plain',
  created_at: '2026-09-23T00:00:00Z',
  missing: false,
});

function run(overrides: Partial<TaskRun> & { id: string }): TaskRun {
  return {
    run_number: 1,
    status: 'SUCCESS',
    trigger_type: 'manual',
    agent_name: 'qoder',
    started_at: '2026-09-23T00:00:00Z',
    finished_at: null,
    duration_ms: null,
    progress: null,
    progress_msg: null,
    summary: null,
    error: null,
    log_count: 0,
    artifacts: [],
    review: null,
    ...overrides,
  };
}

describe('artifactsSourceRun', () => {
  it('目标 Run 自带产物时原样返回，不回退', () => {
    const r2 = run({ id: 'R-2', artifacts: [artifact('a2')] });
    const r1 = run({ id: 'R-1', artifacts: [artifact('a1')] });
    expect(artifactsSourceRun([r2, r1], r2)).toBe(r2);
  });

  it('目标 Run 无产物时回退到列表序最近一个有产物的 Run（重跑场景）', () => {
    const r2 = run({ id: 'R-2', run_number: 2 });
    const r1 = run({ id: 'R-1', run_number: 1, artifacts: [artifact('a1')] });
    expect(artifactsSourceRun([r2, r1], r2)).toBe(r1);
  });

  it('全任务都没有产物时保持目标 Run（走原空态文案）', () => {
    const r2 = run({ id: 'R-2' });
    const r1 = run({ id: 'R-1' });
    expect(artifactsSourceRun([r2, r1], r2)).toBe(r2);
  });

  it('目标为 null（无可关联执行）时不报错', () => {
    expect(artifactsSourceRun(undefined, null)).toBeNull();
  });

  it('与 reviewTargetRun 串联：驳回重跑后弹窗不再空屏', () => {
    const r2 = run({ id: 'R-2', run_number: 2 });
    const r1 = run({
      id: 'R-1',
      run_number: 1,
      artifacts: [artifact('a1')],
      review: { id: 'rv1' } as TaskRun['review'],
    });
    const items = [r2, r1];
    const target = reviewTargetRun(items, null);
    expect(target).toBe(r2);
    expect(artifactsSourceRun(items, target)?.artifacts).toHaveLength(1);
  });
});
