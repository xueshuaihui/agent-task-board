import { Injectable } from '@nestjs/common';
import type { Project } from '@prisma/client';
import { ApiException } from '../contract/errors';
import { newId } from '../contract/ids';
import { nowSql, toIso } from '../contract/time';
import { AuditService } from '../infra/audit.service';
import { PrismaService } from '../infra/prisma.service';
import type { ProjectCreateInput, ProjectDeleteQuery, ProjectPatchInput } from './project.dto';

export interface ProjectDto {
  id: string;
  name: string;
  color: string | null;
  icon: string | null;
  description: string | null;
  status: string;
  sort: number;
  created_at: string | null;
  updated_at: string | null;
}

export interface ProjectDeleteResult {
  id: string;
  deleted: boolean;
  strategy: 'migrate' | 'delete';
  /** strategy=delete 时同步删除的任务数；migrate 时为迁移过去的数量。 */
  affected_tasks: number;
}

function toDto(row: Project): ProjectDto {
  return {
    id: row.id,
    name: row.name,
    color: row.color,
    icon: row.icon,
    description: row.description,
    status: row.status,
    sort: row.sort,
    created_at: toIso(row.createdAt),
    updated_at: toIso(row.updatedAt),
  };
}

@Injectable()
export class ProjectsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  async list(includeArchived = true): Promise<{ items: ProjectDto[] }> {
    const rows = await this.prisma.project.findMany({
      where: includeArchived ? {} : { status: 'ACTIVE' },
      orderBy: [{ sort: 'asc' }, { createdAt: 'asc' }],
    });
    return { items: rows.map(toDto) };
  }

  async create(input: ProjectCreateInput): Promise<ProjectDto> {
    await this.assertNameFree(input.name);
    const id = newId();
    await this.prisma.project.create({
      data: {
        id,
        name: input.name,
        color: input.color ?? null,
        icon: input.icon ?? null,
        description: input.description ?? null,
        sort: input.sort ?? 0,
        createdAt: nowSql(),
        updatedAt: nowSql(),
      },
    });
    await this.audit.record({
      actorType: 'user',
      action: 'project_change',
      targetType: 'project',
      targetId: id,
      after: { name: input.name },
    });
    return toDto(await this.get(id));
  }

  async patch(id: string, input: ProjectPatchInput): Promise<ProjectDto> {
    await this.get(id);
    if (input.name !== undefined) await this.assertNameFree(input.name, id);
    await this.prisma.project.update({
      where: { id },
      data: {
        ...(input.name === undefined ? {} : { name: input.name }),
        ...(input.color === undefined ? {} : { color: input.color }),
        ...(input.icon === undefined ? {} : { icon: input.icon }),
        ...(input.description === undefined ? {} : { description: input.description }),
        ...(input.status === undefined ? {} : { status: input.status }),
        ...(input.sort === undefined ? {} : { sort: input.sort }),
        updatedAt: nowSql(),
      },
    });
    await this.audit.record({
      actorType: 'user',
      action: 'project_change',
      targetType: 'project',
      targetId: id,
      after: { ...input },
    });
    return toDto(await this.get(id));
  }

  /**
   * 删除项目：`?strategy=migrate&targetProjectId=xxx` 把任务迁去目标项目（不含已归档的也一并迁），
   * 默认 `?strategy=delete` 连任务一起删（任务删除会级联 runs/artifacts）。
   * 有子任务挂在待删任务下时由任务删除侧的「父任务不可删」规则拦下。
   */
  async remove(id: string, query: ProjectDeleteQuery): Promise<ProjectDeleteResult> {
    const row = await this.get(id);
    let affected = 0;
    if (query.strategy === 'migrate') {
      if (!query.targetProjectId) {
        throw new ApiException('VALIDATION_FAILED', '迁移目标项目不能为空', [
          { path: 'targetProjectId', code: 'required', message: 'strategy=migrate 必须提供' },
        ]);
      }
      if (query.targetProjectId === id) {
        throw new ApiException('VALIDATION_FAILED', '迁移目标不能是本项目');
      }
      const target = await this.get(query.targetProjectId);
      const moved = await this.prisma.task.updateMany({
        where: { projectId: id },
        data: { projectId: target.id, updatedAt: nowSql() },
      });
      affected = moved.count;
    } else {
      const childCount = await this.prisma.task.count({ where: { projectId: id } });
      if (childCount > 0) {
        const parents = await this.prisma.task.count({
          where: { projectId: id, children: { some: {} } },
        });
        if (parents > 0) {
          throw new ApiException('ILLEGAL_TRANSITION', '项目下存在带子任务的任务，请先处理或改用迁移');
        }
      }
      const deleted = await this.prisma.task.deleteMany({ where: { projectId: id } });
      affected = deleted.count;
    }
    await this.prisma.project.delete({ where: { id } });
    await this.audit.record({
      actorType: 'user',
      action: 'project_change',
      targetType: 'project',
      targetId: id,
      before: { name: row.name },
      after: { deleted: true, strategy: query.strategy, affected_tasks: affected },
    });
    return { id, deleted: true, strategy: query.strategy, affected_tasks: affected };
  }

  private async get(id: string): Promise<Project> {
    const row = await this.prisma.project.findUnique({ where: { id } });
    if (!row) throw new ApiException('NOT_FOUND', `项目 ${id} 不存在`);
    return row;
  }

  private async assertNameFree(name: string, excludeId?: string): Promise<void> {
    const rows = await this.prisma.project.findMany({ where: { name } });
    if (rows.some((row) => row.id !== excludeId)) {
      throw new ApiException('VALIDATION_FAILED', `项目名「${name}」已存在`, [
        { path: 'name', code: 'duplicate_name', message: '项目名不能重复' },
      ]);
    }
  }
}
