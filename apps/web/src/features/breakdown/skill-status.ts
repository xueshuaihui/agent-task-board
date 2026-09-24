import type { BreakdownDraft } from '@/api/types';
import type { Skill } from '@/features/skills/types';

/**
 * v0.0.4 条款 81 / §7.5：GET /breakdown/sessions/{id} 读侧技能解析标注的
 * **web 局部类型镜像**（api 侧见 breakdown.service.ts 的 SkillStatusEntry /
 * SkillResolutionReport）。`skills_status` 尚未进全局 `@/api/types` 镜像（共享
 * 类型文件本片不动），故在 features/breakdown 内就地声明。
 */

export type DraftSkillState = 'resolved' | 'ambiguous' | 'unresolved';

/** 草案 `skill_ids` 里每个原值的解析态（与 skill_ids 逐项对齐）。 */
export interface DraftSkillStatus {
  /** 草案里存的原值（finish 后 resolved/ambiguous 为落定 id，unresolved 仍是 Agent 上报的名字）。 */
  value: string;
  state: DraftSkillState;
  /** 解析落定的技能 id（歧义取「最近更新者」）；unresolved 为 null。 */
  skill_id: string | null;
  /** 命中的技能名；unresolved 时即原值。 */
  name: string;
  /** 同名全部技能 id（含落定者，最近更新者在前）；单命中 resolved 时即 [skill_id]。 */
  candidates: string[];
}

/** session 级汇总报告（与 finish 回包同形状）。 */
export interface SkillResolutionReport {
  ambiguous: { ref: string; name: string; skill_id: string; candidates: string[] }[];
  unresolved: { ref: string; name: string }[];
}

/** 带读侧标注的草案；写端点回执/乐观层不填 skills_status，故为可选。 */
export type AnnotatedDraft = BreakdownDraft & { skills_status?: DraftSkillStatus[] };

/** GET 详情的扩展镜像：drafts 带逐条解析态，session 级带汇总报告。 */
export type BreakdownDetailAnnotated = Omit<
  import('@/api/types').BreakdownSessionDetail,
  'drafts'
> & {
  drafts: AnnotatedDraft[];
  skill_resolution?: SkillResolutionReport;
};

/** 按 skill_ids 原值反查解析态；无标注（写回执乐观窗口）时回 undefined，调用方走旧兜底口径。 */
export function skillStatusOf(draft: AnnotatedDraft, value: string): DraftSkillStatus | undefined {
  return draft.skills_status?.find((entry) => entry.value === value);
}

/** 歧义候选的下拉文案：候选本就同名，无条件带上类型 + 短 ID。 */
export function skillCandidateLabel(skill: Pick<Skill, 'id' | 'name' | 'type'> | undefined, name: string, id: string): string {
  if (!skill) return `${name} · …${id.slice(-6)}`;
  return `${skill.name} · ${skill.type} · …${skill.id.slice(-6)}`;
}
