/**
 * #8 需求级上下文的纯函数口径（无 React/请求依赖，直接给单测与 UI 共用）。
 *
 * 服务端在子任务领取时把「需求技能 ∪ 任务技能」冻结成快照；UI 只做展示标注，
 * 合并顺序与后端 `mergeSkillRefs` 保持一致：需求优先、同 skill_id 去重。
 */

export type SkillSource = 'requirement' | 'task';

export interface MergedSkillSource {
  skill_id: string;
  source: SkillSource;
}

/**
 * 按 skill_id 去重、需求优先：需求 refs 保持原序在前，任务独有的 refs 保持原序在后。
 * 参数顺序固定为（任务, 需求）——与后端 `mergeSkillRefs(taskSkillsJson, requirementSkillsJson)` 同向。
 */
export function mergeSkillSources(
  taskSkillIds: readonly string[],
  requirementSkillIds: readonly string[],
): MergedSkillSource[] {
  const seen = new Set<string>();
  const merged: MergedSkillSource[] = [];
  for (const skillId of requirementSkillIds) {
    if (seen.has(skillId)) continue;
    seen.add(skillId);
    merged.push({ skill_id: skillId, source: 'requirement' });
  }
  for (const skillId of taskSkillIds) {
    if (seen.has(skillId)) continue;
    seen.add(skillId);
    merged.push({ skill_id: skillId, source: 'task' });
  }
  return merged;
}

/** 子任务详情是否要渲染「继承自需求」：规则 trim 非空，或需求至少绑了一个技能。 */
export function hasInheritedContext(
  rules: string | null | undefined,
  requirementSkillCount: number,
): boolean {
  return (typeof rules === 'string' && rules.trim() !== '') || requirementSkillCount > 0;
}
