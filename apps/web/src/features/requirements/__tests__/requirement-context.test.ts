import { describe, expect, it } from 'vitest';
import { hasInheritedContext, mergeSkillSources } from '../requirement-context';

/**
 * #8 需求上下文的两条纯函数判据：
 * - `mergeSkillSources` 与服务端 `mergeSkillRefs` 同序：需求优先、按 skill_id 去重；
 * - `hasInheritedContext` 决定子任务概览是否渲染「继承自需求（强制）」块
 *   （规则 trim 非空或需求至少一个技能）。
 */

describe('mergeSkillSources（任务 ∪ 需求，需求优先去重）', () => {
  it('同 skill_id 需求优先，且需求 refs 在前、任务独有在后', () => {
    expect(mergeSkillSources(['task-a', 'shared'], ['shared', 'req-b'])).toEqual([
      { skill_id: 'shared', source: 'requirement' },
      { skill_id: 'req-b', source: 'requirement' },
      { skill_id: 'task-a', source: 'task' },
    ]);
  });

  it('仅任务绑定：全部标 task，保持原序', () => {
    expect(mergeSkillSources(['task-a', 'task-b'], [])).toEqual([
      { skill_id: 'task-a', source: 'task' },
      { skill_id: 'task-b', source: 'task' },
    ]);
  });

  it('仅需求绑定：全部标 requirement，保持原序', () => {
    expect(mergeSkillSources([], ['req-a', 'req-b'])).toEqual([
      { skill_id: 'req-a', source: 'requirement' },
      { skill_id: 'req-b', source: 'requirement' },
    ]);
  });

  it('两侧都为空返回空数组', () => {
    expect(mergeSkillSources([], [])).toEqual([]);
  });

  it('需求侧自身重复的 skill_id 也只留一条', () => {
    expect(mergeSkillSources(['task-a'], ['req-a', 'req-a'])).toEqual([
      { skill_id: 'req-a', source: 'requirement' },
      { skill_id: 'task-a', source: 'task' },
    ]);
  });
});

describe('hasInheritedContext（是否渲染继承块）', () => {
  it('无规则且无需求技能 → 不渲染', () => {
    expect(hasInheritedContext(null, 0)).toBe(false);
    expect(hasInheritedContext(undefined, 0)).toBe(false);
    expect(hasInheritedContext('   \n\t ', 0)).toBe(false);
  });

  it('规则 trim 后非空 → 渲染', () => {
    expect(hasInheritedContext('先补测试', 0)).toBe(true);
  });

  it('需求有技能（哪怕规则为空）→ 渲染', () => {
    expect(hasInheritedContext(null, 1)).toBe(true);
    expect(hasInheritedContext('', 2)).toBe(true);
  });
});
