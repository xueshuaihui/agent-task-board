import { createHash } from 'node:crypto';
import { toIso } from '../contract/time';
import { parseSkillRefs, type TaskSkillRef } from '../skills/skills.dto';

/**
 * #8 需求级执行规则与技能继承的唯一合并口径。
 *
 * 「需求」是 `type='需求'` 的顶层任务，子任务经 `tasks.parent_task_id` 归属它。
 * 需求级执行规则存 `tasks.execution_rules` / `tasks.execution_rules_updated_at`，
 * 需求技能复用 `tasks.skills`（与任务技能同一列型）。
 *
 * WHY 只留这一份：query（get_task / claim 回执）与 claim（Run 快照）必须给出一致的
 * effective_skills；两处各写一套合并逻辑，迟早出现「回执说技能 A 来自需求、快照却说来自任务」
 * 的口径漂移，digest 也会因此对不上。
 */

/** 需求任务的 type 字面量（0919 约定：需求 = 顶层 `type='需求'` 的任务）。 */
export const REQUIREMENT_TASK_TYPE = '需求';

/** 技能引用来源：任务自身绑定 / 所属需求绑定（同 skill_id 需求优先）。 */
export type SkillSource = 'task' | 'requirement';

export interface EffectiveSkillRef {
  skill_id: string;
  version?: string;
  source: SkillSource;
}

/** 需求侧快照：只在父任务确实是 `type='需求'` 时非空。 */
export interface RequirementInfo {
  id: string;
  title: string;
  execution_rules: string | null;
  execution_rules_updated_at: string | null;
  skills: TaskSkillRef[];
}

export interface RequirementSnapshot {
  requirement: RequirementInfo | null;
  task_skills: TaskSkillRef[];
  effective_skills: EffectiveSkillRef[];
}

/** 冻结进 `task_runs.rules_snapshot` 的完整形态：规则/技能 + 领取时刻。 */
export interface RulesSnapshot extends RequirementSnapshot {
  captured_at: string;
}

/** `buildRequirementSnapshot` 需要的父任务列（query 与 claim 共用同一 select 形状）。 */
export interface RequirementParent {
  id: string;
  title: string;
  type: string;
  skills: string;
  executionRules: string | null;
  executionRulesUpdatedAt: string | null;
}

/**
 * 规则列的归一：非字符串或 trim 后为空一律 null（空白串不是「有规则」），
 * 非空时保留原文——规则是用户写的执行约束，不做内容改写。
 */
export function normalizeExecutionRules(raw: string | null | undefined): string | null {
  if (typeof raw !== 'string') return null;
  return raw.trim() === '' ? null : raw;
}

/** `list_ready_tasks` 摘要用：规则 trim 后是否非空（不回规则全文）。 */
export function hasExecutionRules(raw: string | null | undefined): boolean {
  return typeof raw === 'string' && raw.trim() !== '';
}

function toEffectiveRef(ref: TaskSkillRef, source: SkillSource): EffectiveSkillRef {
  // 字段顺序固定（skill_id, version, source）：version 缺省时 JSON.stringify 省略该键，
  // 但键序不随输入 JSON 的书写顺序漂移，digest 才稳定。
  return { skill_id: ref.skill_id, version: ref.version, source };
}

/**
 * 有效技能 = 需求技能 ∪ 任务技能。
 * - 同 skill_id 去重，**需求版本优先**（任务侧即使绑了别的版本也用需求 ref）；
 * - 输出顺序固定：需求 refs 在前（保持需求侧原序），任务独有在后（保持任务侧原序）。
 */
export function mergeSkillRefs(
  taskSkillsJson: string | null,
  requirementSkillsJson: string | null,
): EffectiveSkillRef[] {
  const seen = new Set<string>();
  const requirementRefs: EffectiveSkillRef[] = [];
  for (const ref of parseSkillRefs(requirementSkillsJson)) {
    if (seen.has(ref.skill_id)) continue;
    seen.add(ref.skill_id);
    requirementRefs.push(toEffectiveRef(ref, 'requirement'));
  }
  const taskOnlyRefs: EffectiveSkillRef[] = [];
  for (const ref of parseSkillRefs(taskSkillsJson)) {
    if (seen.has(ref.skill_id)) continue;
    seen.add(ref.skill_id);
    taskOnlyRefs.push(toEffectiveRef(ref, 'task'));
  }
  return [...requirementRefs, ...taskOnlyRefs];
}

/**
 * 由任务技能列与父任务行构建快照。父任务不是 `type='需求'` 时视同无需求：
 * requirement=null，effective_skills 全部为任务自身引用（source='task'），
 * 保证旧客户端拿到的有效技能清单与旧字段 `skills` 一一对应。
 */
export function buildRequirementSnapshot(
  taskSkillsJson: string | null,
  parent: RequirementParent | null,
): RequirementSnapshot {
  const taskSkills = parseSkillRefs(taskSkillsJson);
  const requirementParent = parent !== null && parent.type === REQUIREMENT_TASK_TYPE ? parent : null;
  const requirement: RequirementInfo | null = requirementParent
    ? {
        id: requirementParent.id,
        title: requirementParent.title,
        execution_rules: normalizeExecutionRules(requirementParent.executionRules),
        execution_rules_updated_at: toIso(requirementParent.executionRulesUpdatedAt),
        skills: parseSkillRefs(requirementParent.skills),
      }
    : null;
  return {
    requirement,
    task_skills: taskSkills,
    effective_skills: mergeSkillRefs(
      taskSkillsJson,
      requirementParent ? requirementParent.skills : null,
    ),
  };
}

/** 领取时冻结：captured_at 只进快照文本，不参与 digest（同一规则任何时刻领取 digest 相同）。 */
export function buildRulesSnapshot(
  snapshot: RequirementSnapshot,
  capturedAt: string,
): RulesSnapshot {
  return {
    requirement: snapshot.requirement,
    task_skills: snapshot.task_skills,
    effective_skills: snapshot.effective_skills,
    captured_at: capturedAt,
  };
}

/**
 * SHA-256（64 位 hex）。显式挑三个业务字段并固定键序，而不是直接 hash 入参对象——
 * 调用方多传了 captured_at 或键序不同都不该改变「同一套规则」的指纹。
 */
export function digestRulesSnapshot(snapshot: RequirementSnapshot): string {
  const canonical = {
    requirement: snapshot.requirement,
    task_skills: snapshot.task_skills,
    effective_skills: snapshot.effective_skills,
  };
  return createHash('sha256').update(JSON.stringify(canonical)).digest('hex');
}
