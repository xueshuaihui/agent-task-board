import { describe, expect, it } from 'vitest';
import { toggleDraftSkillId } from '../draft-editor';

/**
 * D-3 接线层纯函数测试：拆解草案技能候选行点击的 skill_ids 增删切换。
 * （web 无 @testing-library，组件交互留 C-6 真机走查；这里只钉数据形状不变式：
 * 顺序保持、末尾追加、原位移除、不改入参数组。）
 */

describe('toggleDraftSkillId（草案 skill_ids 增删切换）', () => {
  it('未选中 → 末尾追加，原有顺序不动', () => {
    expect(toggleDraftSkillId(['skl_a', 'skl_b'], 'skl_c')).toEqual(['skl_a', 'skl_b', 'skl_c']);
  });

  it('已选中 → 原位移除（与 chip 移除按钮同一语义）', () => {
    expect(toggleDraftSkillId(['skl_a', 'skl_b', 'skl_c'], 'skl_b')).toEqual(['skl_a', 'skl_c']);
  });

  it('来回切换回到原集合，且不修改入参数组', () => {
    const current = ['skl_a'];
    const added = toggleDraftSkillId(current, 'skl_b');
    expect(toggleDraftSkillId(added, 'skl_b')).toEqual(current);
    expect(current).toEqual(['skl_a']);
  });
});
