import type { Artifact, Review, Task, TaskDependency } from '@prisma/client';
import type { ClaimReason, TaskStatus } from '../contract/enums';
import { toIso } from '../contract/time';
import { parseJsonArray, parseJsonObject } from '../tasks/task.dto';
import type { TaskSkillPayload } from '../skills/skills.dto';

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
  /** 0919 10.3：随任务下发的技能（含内容/版本/MCP 依赖）。 */
  skills: TaskSkillPayload[];
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
    name: String(metadata.name ?? artifact.uri.split('/').pop() ?? artifact.uri),
    size_bytes: artifact.sizeBytes,
    mime_type: artifact.mimeType,
  };
}

export function buildTaskPayload(
  task: Task,
  dependencies: AgentDependencies,
  reviewFeedback: ReviewFeedbackItem[],
  skills: TaskSkillPayload[] = [],
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
  };
}
