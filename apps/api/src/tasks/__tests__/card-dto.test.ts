import { describe, expect, it } from 'vitest';
import { toCardDto, type TaskRow } from '../task.dto';

/** 20.11：读路径遇到表外枚举值时原样透传，不给它编一个合法标签。 */
function row(overrides: Partial<TaskRow>): TaskRow {
  return {
    id: 'T-1',
    type: '需求',
    title: '表外状态',
    description: null,
    status: 'BACKLOG',
    priority: 2,
    tags: null,
    required_capabilities: null,
    custom_fields: null,
    pinned: 0,
    due_at: null,
    archived_at: null,
    lease_id: null,
    lease_expires_at: null,
    lease_revoked_at: null,
    stop_reason: null,
    current_run_id: null,
    claimed_at: null,
    run_count: 0,
    created_at: null,
    updated_at: null,
    progress: null,
    progress_msg: null,
    agent_name: null,
    blocked_count: 0,
    artifact_count: 0,
    last_run_duration_ms: null,
    last_run_started_at: null,
    ...overrides,
  };
}

describe('toCardDto 的 status_label', () => {
  it('六个已知状态各给中文名', () => {
    const labels: Record<string, string> = {
      BACKLOG: '需求池',
      READY: '待执行',
      RUNNING: '执行中',
      REVIEW: '待审核',
      DONE: '已完成',
      FAILED: '异常/失败',
    };
    for (const [status, label] of Object.entries(labels)) {
      expect(toCardDto(row({ status })).status_label).toBe(label);
    }
  });

  it('表外状态留空标签并原样带出 status，界面据此渲染「未知（原值）」', () => {
    const card = toCardDto(row({ status: 'PENDING_REVIEW' }));
    expect(card.status).toBe('PENDING_REVIEW');
    expect(card.status_label).toBe('');
  });
});
