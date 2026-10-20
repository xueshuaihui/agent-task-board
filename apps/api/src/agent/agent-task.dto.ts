import type { Artifact, Review, Task, TaskDependency } from '@prisma/client';
import type { ClaimReason, TaskStatus } from '../contract/enums';
import { toIso } from '../contract/time';
import { parseJsonArray, parseJsonObject } from '../tasks/task.dto';
import { artifactUriBasename } from '../artifacts/artifact-storage';
import type { TaskSkillPayload } from '../skills/skills.dto';
import type { SkillSource } from './requirement-context';

/** 12 章 `review_feedback` 元素：只给结论与三字段，不给审核时间等 UI 负担。 */
export interface ReviewFeedbackItem {
  run_id: string | null;
  conclusion: string;
  suggestion: string;
  reason: string;
  detail: string;
}

export interface AgentDependencies {
  blocks: { id: string; title: string }[];
  relates: { id: string; title: string }[];
}

/**
 * #8：所属需求（`type='需求'` 的父任务）。`execution_rules` 为需求级强制规则，
 * `skills` 为需求绑定技能（强制生效）；无父需求时整个字段为 null。
 */
export interface AgentRequirementPayload {
  id: string;
  title: string;
  execution_rules: string | null;
  execution_rules_updated_at: string | null;
  skills: TaskSkillPayload[];
}

/** 有效技能 = 需求 ∪ 任务（同 skill_id 需求优先），`source` 标明这条来自哪一侧。 */
export interface AgentEffectiveSkillPayload extends TaskSkillPayload {
  source: SkillSource;
}

/** 12 章 `claim_next_task` / `get_task` 的 task 形状（字段顺序与文档样例一致）。 */
export interface AgentTaskPayload {
  id: string;
  title: string;
  description: string | null;
  type: string;
  priority: number;
  tags: string[];
  pinned: boolean;
  status: TaskStatus;
  run_count: number;
  due_at: string | null;
  created_at: string | null;
  updated_at: string | null;
  archived_at: string | null;
  custom_fields: Record<string, unknown>;
  required_capabilities: string[];
  dependencies: AgentDependencies;
  review_feedback: ReviewFeedbackItem[];
  /** 0919 10.3：随任务下发的技能（含内容/版本/MCP 依赖）；仍只含任务自身绑定。 */
  skills: TaskSkillPayload[];
  /** #8：所属需求（规则 + 强制技能）；无父需求为 null。 */
  requirement: AgentRequirementPayload | null;
  /** #8：合并后的完整技能清单（需求优先）。旧客户端可忽略，只看 `skills`。 */
  effective_skills: AgentEffectiveSkillPayload[];
}

export interface LeaseDto {
  lease_id: string;
  run_id: string;
  expires_at: string | null;
  ttl_minutes: number;
}

export interface ClaimResult {
  task: AgentTaskPayload | null;
  lease?: LeaseDto;
  reason?: ClaimReason;
  /** #6：认领成功时随回执下发的执行进度节奏（中文一段）；未领到时不带。 */
  progress_contract?: string;
  /** #8：本次 Run 规则快照的 SHA-256（与 task_runs.rules_digest 同值）；未领到时不带。 */
  rules_digest?: string;
}

export function toReviewFeedback(reviews: Review[]): ReviewFeedbackItem[] {
  return reviews.map((review) => ({
    run_id: review.runId,
    conclusion: review.conclusion,
    suggestion: review.suggestion,
    reason: review.reason,
    detail: review.detail,
  }));
}

/**
 * `dependencies` 按 `type` 分组而不是按方向：12 章样例给的是 blocks/relates 两个键，
 * Agent 只关心「会不会挡住我」，方向信息在 status 里已经能从任务本身推出来。
 */
export function groupDependencies(deps: (TaskDependency & { title: string })[]): AgentDependencies {
  const grouped: AgentDependencies = { blocks: [], relates: [] };
  for (const dep of deps) {
    grouped[dep.type === 'relates' ? 'relates' : 'blocks'].push({ id: dep.dependsOn, title: dep.title });
  }
  return grouped;
}

export function toArtifactDto(artifact: Artifact): {
  id: string;
  type: string;
  uri: string;
  name: string;
  size_bytes: number | null;
  mime_type: string | null;
} {
  const metadata = parseJsonObject(artifact.metadata);
  return {
    id: artifact.id,
    type: artifact.type,
    uri: artifact.uri,
    name: String(metadata.name ?? artifactUriBasename(artifact.uri)),
    size_bytes: artifact.sizeBytes,
    mime_type: artifact.mimeType,
  };
}

export function buildTaskPayload(
  task: Task,
  dependencies: AgentDependencies,
  reviewFeedback: ReviewFeedbackItem[],
  skills: TaskSkillPayload[] = [],
  requirement: AgentRequirementPayload | null = null,
  effectiveSkills: AgentEffectiveSkillPayload[] = skills.map((skill) => ({
    ...skill,
    source: 'task' as const,
  })),
): AgentTaskPayload {
  return {
    id: task.id,
    title: task.title,
    description: task.description,
    type: task.type,
    priority: task.priority,
    tags: parseJsonArray(task.tags),
    pinned: task.pinned === 1,
    status: task.status as TaskStatus,
    run_count: task.runCount,
    due_at: task.dueAt,
    created_at: toIso(task.createdAt),
    updated_at: toIso(task.updatedAt),
    archived_at: toIso(task.archivedAt),
    custom_fields: parseJsonObject(task.customFields),
    required_capabilities: parseJsonArray(task.requiredCapabilities),
    dependencies,
    review_feedback: reviewFeedback,
    skills,
    requirement,
    effective_skills: effectiveSkills,
  };
}
