import { describe, expect, it } from 'vitest';
import type { TaskListItem } from '@/api/types';
import type { Group } from '@/features/groups/types';
import {
  buildRequirementOptions,
  requirementCreateBody,
  requirementMoveBody,
  requirementTitleForGroup,
  type RequirementOption,
} from '../use-requirement-options';

/**
 * §19.14·86（W2-a 切片 1）：需求候选与归属字段构造的正向闸。
 * web 无 jsdom/@testing-library，这里钉的是 hook 的纯函数层
 * （候选派生 + 创建/移动两条写入路径的 payload 形状）。
 */

function taskRow(partial: Partial<TaskListItem> & { id: string; title: string }): TaskListItem {
  return { group_id: null, type: '需求', ...partial } as TaskListItem;
}

function group(id: string, status: string): Group {
  return {
    id,
    name: `g-${id}`,
    color: null,
    icon: null,
    description: null,
    status,
    sort: 0,
    is_default: 0,
    archived_at: null,
    created_at: null,
    updated_at: null,
  };
}

describe('buildRequirementOptions：候选派生与归档剔除', () => {

  const tasks = [
    taskRow({ id: 'r-1', title: '活跃需求', group_id: 'g-active' }),
    taskRow({ id: 'r-2', title: '归档组需求', group_id: 'g-archived' }),
    taskRow({ id: 'r-3', title: '未归属需求', group_id: null }),
  ];
  const groups = [group('g-active', 'ACTIVE'), group('g-archived', 'ARCHIVED')];

  it('返回 { id, title, group_id } 三字段形状', () => {
    expect(buildRequirementOptions([tasks[0]!], [])).toEqual([
      { id: 'r-1', title: '活跃需求', group_id: 'g-active' },
    ]);
  });

  it('归档分组下的需求不进候选（status !== ACTIVE 即剔除）', () => {
    const ids = buildRequirementOptions(tasks, groups).map((option) => option.id);
    expect(ids).toEqual(['r-1', 'r-3']);
    expect(ids).not.toContain('r-2');
  });

  it('groups 缓存未就绪（undefined）时不清空候选也不误滤', () => {
    expect(buildRequirementOptions(tasks, undefined).map((option) => option.id)).toEqual([
      'r-1',
      'r-2',
      'r-3',
    ]);
  });

  it('未知分组（缓存里没有该 id）保留——判定宁缺毋滥，服务端 409 是最后防线', () => {
    const ids = buildRequirementOptions(tasks, [group('g-active', 'ACTIVE')]).map((o) => o.id);
    expect(ids).toContain('r-2');
  });

  it('任务未加载时给空数组', () => {
    expect(buildRequirementOptions(undefined, groups)).toEqual([]);
  });
});

describe('§19.14·86 归属字段构造：创建/移动两条写入路径', () => {
  const option: RequirementOption = { id: 'r-1', title: '活跃需求', group_id: 'g-active' };

  it('选需求：创建 payload 同时含 parent_task_id + group_id，且 group 等于该需求的组', () => {
    expect(requirementCreateBody(option)).toEqual({ parent_task_id: 'r-1', group_id: 'g-active' });
  });

  it('未选需求：创建 payload 两字段皆无（服务端落默认分组兜底）', () => {
    const body = requirementCreateBody(null);
    expect(body).toEqual({});
    expect(body).not.toHaveProperty('parent_task_id');
    expect(body).not.toHaveProperty('group_id');
  });

  it('移到需求：一次 PATCH 原子写两字段', () => {
    expect(requirementMoveBody(option)).toEqual({ parent_task_id: 'r-1', group_id: 'g-active' });
  });

  it('「未分配」：parent_task_id 置 null、group_id 不发（保持原组）', () => {
    const body = requirementMoveBody(null);
    expect(body).toEqual({ parent_task_id: null });
    expect(body).not.toHaveProperty('group_id');
  });
});

describe('requirementTitleForGroup：展示层 group_id→需求标题反查（W2-b 确认卡）', () => {
  const options: RequirementOption[] = [
    { id: 'r-1', title: '需求甲', group_id: 'g-1' },
    { id: 'r-2', title: '无组需求', group_id: null },
  ];

  it('组内有需求返回其标题（同组多需求取首个，拆解口径一组一需求）', () => {
    expect(requirementTitleForGroup(options, 'g-1')).toBe('需求甲');
    expect(
      requirementTitleForGroup(
        [
          { id: 'a', title: '首条', group_id: 'g' },
          { id: 'b', title: '次条', group_id: 'g' },
        ],
        'g',
      ),
    ).toBe('首条');
  });

  it('组内无需求 / groupId 为空回 null——由调用方兜「未分配」文案', () => {
    expect(requirementTitleForGroup(options, 'g-none')).toBeNull();
    expect(requirementTitleForGroup(options, null)).toBeNull();
    expect(requirementTitleForGroup(options, undefined)).toBeNull();
  });
});
