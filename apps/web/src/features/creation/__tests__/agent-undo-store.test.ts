import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  agentUndoLabel,
  agentUndoMsLeft,
  DONE_LINGER_MS,
  UNDO_WINDOW_MS,
  useAgentUndoStore,
} from '../store';

/**
 * v0.0.4 真机补验缺陷 1 的回归单测：
 * AgentUndoStack 旧实现用组件挂载时初始化的 `tick` 参与倒计时数值计算，
 * entries 0→1 首帧 tick 远早于 createdAtMs，msLeft 虚高到 60s+（「撤销 63s」）。
 * 修复后数值只出自纯函数 `agentUndoMsLeft(entry, now)`，且负经过时长被夹到 0。
 */

const T0 = 1_700_000_000_000;

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(T0);
  useAgentUndoStore.setState({ entries: [] });
});

afterEach(() => {
  vi.useRealTimers();
});

describe('agentUndoMsLeft：首帧倒计时不虚高', () => {
  it('push 后立刻取当前时刻计算，msLeft ≤ UNDO_WINDOW_MS（5000）', () => {
    useAgentUndoStore.getState().push('T-undo-1');
    const entry = useAgentUndoStore.getState().entries[0];
    expect(entry).toBeDefined();

    const msLeft = agentUndoMsLeft(entry, Date.now());
    expect(msLeft).toBeLessThanOrEqual(5000);
    expect(msLeft).toBe(UNDO_WINDOW_MS);
    // 按钮文案口径：首帧至多「撤销 5s」。
    expect(Math.ceil(msLeft / 1000)).toBeLessThanOrEqual(5);
    expect(agentUndoLabel(entry, Date.now())).toBe('撤销 5s');
  });

  it('传入远早于 createdAtMs 的旧 tick 也不再虚高（旧实现在这里算出 63s）', () => {
    vi.setSystemTime(T0 + 58_000);
    useAgentUndoStore.getState().push('T-undo-2');
    const entry = useAgentUndoStore.getState().entries[0];

    // 旧实现：UNDO_WINDOW_MS - (staleTick - createdAtMs) = 5000 + 58000 = 63000。
    const staleTick = entry.createdAtMs - 58_000;
    const msLeft = agentUndoMsLeft(entry, staleTick);
    expect(msLeft).toBeLessThanOrEqual(UNDO_WINDOW_MS);
    expect(agentUndoLabel(entry, staleTick)).toBe('撤销 5s');
  });

  it('窗口内单调递减，到期归零', () => {
    useAgentUndoStore.getState().push('T-undo-3');
    const entry = useAgentUndoStore.getState().entries[0];

    expect(agentUndoMsLeft(entry, entry.createdAtMs + 1_000)).toBe(4_000);
    expect(agentUndoMsLeft(entry, entry.createdAtMs + 4_999)).toBe(1);
    expect(agentUndoMsLeft(entry, entry.createdAtMs + 5_000)).toBe(0);
    // 超窗后恒为 0，不出现负数。
    expect(agentUndoMsLeft(entry, entry.createdAtMs + 9_000)).toBe(0);
  });

  it('已撤销条目不再给倒计时', () => {
    useAgentUndoStore.getState().push('T-undo-4');
    const entry = useAgentUndoStore.getState().entries[0];
    expect(agentUndoMsLeft({ ...entry, undone: true }, entry.createdAtMs)).toBe(0);
  });
});

describe('useAgentUndoStore：入栈与回收', () => {
  it('同 taskId 重复 push 只留一条', () => {
    const { push } = useAgentUndoStore.getState();
    push('T-dupe');
    push('T-dupe');
    expect(useAgentUndoStore.getState().entries).toHaveLength(1);
  });

  it('prune：超 5 秒未撤销的消失；已撤销的留满回显期后消失', () => {
    useAgentUndoStore.getState().push('T-expire');
    const entry = useAgentUndoStore.getState().entries[0];

    useAgentUndoStore.getState().prune(entry.createdAtMs + UNDO_WINDOW_MS);
    expect(useAgentUndoStore.getState().entries).toHaveLength(0);

    vi.setSystemTime(T0);
    useAgentUndoStore.getState().push('T-undone');
    useAgentUndoStore.getState().markUndone('T-undone');
    const undoneEntry = useAgentUndoStore.getState().entries[0];
    useAgentUndoStore.getState().prune(undoneEntry.undoneAtMs! + DONE_LINGER_MS - 1);
    expect(useAgentUndoStore.getState().entries).toHaveLength(1);
    useAgentUndoStore.getState().prune(undoneEntry.undoneAtMs! + DONE_LINGER_MS);
    expect(useAgentUndoStore.getState().entries).toHaveLength(0);
  });
});
