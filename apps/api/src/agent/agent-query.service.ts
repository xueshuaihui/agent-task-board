import { Injectable } from '@nestjs/common';
import type { Review, Task } from '@prisma/client';
import { ApiException } from '../contract/errors';
import { toIso } from '../contract/time';
import { parseJsonArray } from '../tasks/task.dto';
import type { RequestAuth } from '../auth/auth.scope';
import { PrismaService } from '../infra/prisma.service';
import { agentOf } from './agent-auth';
import type { GetTaskInput, ReviewFeedbackInput } from './agent-inputs';
import {
  buildTaskPayload,
  groupDependencies,
  toReviewFeedback,
  type AgentTaskPayload,
  type ReviewFeedbackItem,
} from './agent-task.dto';

type DependencyRow = { id: string; depends_on: string; type: string; title: string };

@Injectable()
export class AgentQueryService {
  constructor(private readonly prisma: PrismaService) {}

  /** `get_task`：任务详情 + 审核意见 + 自定义字段 + 依赖（12 章）。 */
  async getTask(input: GetTaskInput, auth: RequestAuth): Promise<{ task: AgentTaskPayload }> {
    agentOf(auth);
    return { task: await this.payload(input.task_id) };
  }

  async reviewFeedback(
    input: ReviewFeedbackInput,
    auth: RequestAuth,
  ): Promise<{ review_feedback: ReviewFeedbackItem[] }> {
    agentOf(auth);
    const task = await this.prisma.task.findUnique({ where: { id: input.task_id } });
    if (!task) throw new ApiException('NOT_FOUND', '任务不存在');
    return { review_feedback: toReviewFeedback(await this.reviews(input.task_id, input.limit)) };
  }

  /** 认领/详情共用的完整载荷。 */
  async payload(taskId: string): Promise<AgentTaskPayload> {
    const task = await this.prisma.task.findUnique({ where: { id: taskId } });
    if (!task) throw new ApiException('TASK_GONE', '任务已删除');
    return buildTaskPayload(task, await this.deps(taskId), toReviewFeedback(await this.reviews(taskId, 5)));
  }

  /** `list_ready_tasks` 的精简卡片：够 Agent 决定领哪个，不带描述与产物。 */
  async summary(taskId: string, accountId: string) {
    const task = await this.prisma.task.findFirst({ where: { id: taskId, accountId } });
    if (!task) throw new ApiException('TASK_GONE', '任务已删除');
    return {
      id: task.id,
      title: task.title,
      type: task.type,
      priority: task.priority,
      tags: parseJsonArray(task.tags),
      pinned: task.pinned === 1,
      status: task.status,
      run_count: task.runCount,
      due_at: task.dueAt,
      required_capabilities: parseJsonArray(task.requiredCapabilities),
      created_at: toIso(task.createdAt),
    };
  }

  private async reviews(taskId: string, limit: number): Promise<Review[]> {
    return this.prisma.review.findMany({
      where: { taskId },
      orderBy: { createdAt: 'desc' },
      take: limit,
    });
  }

  /** 只取该任务的前置（Agent 关心的是「谁会挡我」，后续任务由看板展示）。 */
  private async deps(taskId: string) {
    const rows = await this.prisma.$queryRaw<DependencyRow[]>`
      SELECT d.id, d.depends_on, d.type, t.title
      FROM task_dependencies d JOIN tasks t ON t.id = d.depends_on
      WHERE d.task_id = ${taskId}
      ORDER BY d.type, d.depends_on`;
    return groupDependencies(
      rows.map((row) => ({
        id: row.id,
        taskId,
        dependsOn: row.depends_on,
        type: row.type,
        createdAt: '',
        title: row.title,
      })),
    );
  }
}
