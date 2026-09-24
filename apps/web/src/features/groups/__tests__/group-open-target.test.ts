import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * §19.14·84/85（v0.0.4 W2-b 切片 4）：groups-page「打开」跳转目标修复 +
 * use-group-scoped 陈旧注释改写。
 *
 * W1 遗留退化项：看板可见面不再消费 groups（`toBoardQuery` 恒剥离），
 * 「写 store.groups 后跳看板」落到看板即失效；列表侧（作用域 chip「分组：xxx」、
 * `useTaskListWithGroups`）仍是 groups 键的合法消费者，跳转目标改为列表路由 `tasks`。
 * web 无 jsdom，用源码扫描钉跳转目标（口径同 W2-a 看板闸）。UI 未真机验证。
 */

const groupsPage = readFileSync(join(__dirname, '..', 'groups-page.tsx'), 'utf8');
const useGroupScoped = readFileSync(join(__dirname, '..', 'use-group-scoped.ts'), 'utf8');

describe('groups-page 源码闸：「打开」跳列表路由而非看板', () => {
  it('写 groups 维后 navigate 目标是 tasks（列表），不再是 board', () => {
    expect(groupsPage).toContain("setDimension('groups'");
    expect(groupsPage).toContain("navigate('tasks')");
    expect(groupsPage).not.toContain("navigate('board')");
  });

  it('注释按现实改写：不再声称「写进看板分组偏好后跳看板」', () => {
    expect(groupsPage).not.toContain('跳看板）');
    expect(groupsPage).toContain('看板不消费 groups');
  });
});

describe('use-group-scoped 源码闸：toBoardQuery 陈旧注释清零', () => {
  it('不再声称 groups 由 toBoardQuery 带出；写明恒剥离、名字是历史壳', () => {
    expect(useGroupScoped).not.toContain('已由 `toBoardQuery` 从统一过滤 store 带出');
    expect(useGroupScoped).toContain('恒不带出 groups');
    expect(useGroupScoped).toContain('只服务列表作用域');
  });
});
