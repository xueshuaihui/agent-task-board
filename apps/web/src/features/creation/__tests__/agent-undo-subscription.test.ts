import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { handleAgentTaskCreated, useAgentUndoStore } from '../store';

/**
 * v0.0.4 §8.6 真机缺陷的回归单测（P1：无卡片时直建撤销浮层永远不出现）。
 *
 * 根因：`task.created → push` 的订阅原先住在 `AgentUndoStack` 内，而该组件只在
 * `CreationRequestHost` 渲染出 portal 内容时才挂载——全新加载页面（右下角无任何卡片）
 * 宿主直接 return null，订阅从未注册，Agent direct/silent 直建的撤销卡不出现。
 * 修复：订阅上提到常挂载的宿主（OverlaySlot 无条件渲染它，hooks 永远执行），
 * 处理器逻辑抽成纯函数 `handleAgentTaskCreated` 留在这层可单测。
 *
 * 说明：web 侧 vitest 无 DOM 基建（无 jsdom/@testing-library），组件级「挂载即订阅」
 * 无法在此断言；按修复约定测这层纯逻辑 + store 联动的口径。
 */

beforeEach(() => {
  useAgentUndoStore.setState({ entries: [] });
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('handleAgentTaskCreated：订阅处理器只在 agent 直建时入栈', () => {
  it('origin_type==="agent" → 调用 push（宿主事件回调 → store 入栈链路）', () => {
    const push = vi.fn();
    const handled = handleAgentTaskCreated({ id: 'T-agent-direct', origin_type: 'agent' }, push);
    expect(handled).toBe(true);
    expect(push).toHaveBeenCalledExactlyOnceWith('T-agent-direct');
  });

  it('user 自建 / 缺省 origin_type 不入栈（拆解确认建与用户手建不挂撤销入口）', () => {
    const push = vi.fn();
    expect(handleAgentTaskCreated({ id: 'T-user', origin_type: 'user' }, push)).toBe(false);
    expect(handleAgentTaskCreated({ id: 'T-legacy' }, push)).toBe(false);
    expect(push).not.toHaveBeenCalled();
  });

  it('接真实 store：空栈（模拟全新加载页面）收到 agent 事件即出现撤销条目', () => {
    // 回归的就是「无任何卡片」这一初始态：entries 为空时事件到达也必须入栈。
    expect(useAgentUndoStore.getState().entries).toHaveLength(0);
    const handled = handleAgentTaskCreated(
      { id: 'T-fresh-page', origin_type: 'agent' },
      (taskId) => useAgentUndoStore.getState().push(taskId),
    );
    expect(handled).toBe(true);
    const entries = useAgentUndoStore.getState().entries;
    expect(entries).toHaveLength(1);
    expect(entries[0]?.taskId).toBe('T-fresh-page');
    expect(entries[0]?.undone).toBe(false);
  });
});
