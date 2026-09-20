import { Injectable } from '@nestjs/common';
import type { Group } from '@prisma/client';
import { ApiException } from '../contract/errors';
import { newId } from '../contract/ids';
import { nowSql, toIso } from '../contract/time';
import { AuditService } from '../infra/audit.service';
import { PrismaService } from '../infra/prisma.service';
import type { GroupCreateInput, GroupDeleteQuery, GroupPatchInput } from './group.dto';

/** §5.5 约束：分组数量上限 50（仅计活跃分组，归档分组不占额）。 */
export const GROUP_LIMIT = 50;

export interface GroupDto {
  id: string;
  name: string;
  color: string | null;
  icon: string | null;
  description: string | null;
  status: string;
  sort: number;
  /** v0.0.4 W1-D1 §5.2/§19：1=预置「默认」分组（不可删/不可归档）。SQLite 无布尔，透传 0/1。 */
  is_default: number;
  created_at: string | null;
  updated_at: string | null;
}

export interface GroupDeleteResult {
  id: string;
  deleted: boolean;
  strategy: 'migrate' | 'cascade';
  /** strategy=cascade 时同步删除的任务数；migrate 时为迁移过去的数量。 */
  affected_tasks: number;
}

function toDto(row: Group): GroupDto {
  return {
    id: row.id,
    name: row.name,
    color: row.color,
    icon: row.icon,
    description: row.description,
    status: row.status,
    sort: row.sort,
    is_default: row.isDefault,
    created_at: toIso(row.createdAt),
    updated_at: toIso(row.updatedAt),
  };
}

@Injectable()
export class GroupsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  async list(includeArchived = true): Promise<{ items: GroupDto[] }> {
    const rows = await this.prisma.group.findMany({
      where: includeArchived ? {} : { status: 'ACTIVE' },
      orderBy: [{ sort: 'asc' }, { createdAt: 'asc' }],
    });
    return { items: rows.map(toDto) };
  }

  async create(input: GroupCreateInput): Promise<GroupDto> {
    await this.assertNameFree(input.name);
    await this.assertLimitFree();
    const id = newId();
    await this.prisma.group.create({
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
      action: 'group_change',
      targetType: 'group',
      targetId: id,
      after: { name: input.name },
    });
    return toDto(await this.get(id));
  }

  async patch(id: string, input: GroupPatchInput): Promise<GroupDto> {
    const row = await this.get(id);
    if (input.name !== undefined) await this.assertNameFree(input.name, id);
    // §5.6（W4 才做完整归档闭环）：先落防御性校验——默认分组不可归档。
    if (input.status === 'ARCHIVED' && row.isDefault === 1) {
      throw new ApiException('GROUP_DEFAULT_PROTECTED', '默认分组不可归档');
    }
    // is_default 不在 groupPatchSchema 里：PATCH 改不到它本就是契约的一部分
    // （预置标记只认迁移植入，不认任何写入口），这里多余的数据面兜底都不需要。
    await this.prisma.group.update({
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
      action: 'group_change',
      targetType: 'group',
      targetId: id,
      after: { ...input },
    });
    return toDto(await this.get(id));
  }

  /**
   * 删除分组：`?strategy=migrate&targetGroupId=xxx` 把任务迁去目标分组（含已归档的也一并迁；
   * §5.5 对话框默认迁去「默认」分组，目标由前端显式给出），
   * 默认 `?strategy=cascade` 连任务一起删（任务删除会级联 runs/artifacts）。
   * 有子任务挂在待删任务下时由任务删除侧的「父任务不可删」规则拦下。
   * 默认分组在任何策略下都不可删（§5.2 / 验收 7）。
   */
  async remove(id: string, query: GroupDeleteQuery): Promise<GroupDeleteResult> {
    const row = await this.get(id);
    // §5.2 / 验收 7：默认分组是任务的兜底归属（新建未指定分组即落它），任何策略下都不可删。
    if (row.isDefault === 1) {
      throw new ApiException('GROUP_DEFAULT_PROTECTED', '默认分组不可删除');
    }
    let affected = 0;
    if (query.strategy === 'migrate') {
      if (!query.targetGroupId) {
        throw new ApiException('VALIDATION_FAILED', '迁移目标分组不能为空', [
          { path: 'targetGroupId', code: 'required', message: 'strategy=migrate 必须提供' },
        ]);
      }
      if (query.targetGroupId === id) {
        throw new ApiException('VALIDATION_FAILED', '迁移目标不能是本分组');
      }
      // §5.5「迁移到默认分组」是删除对话框的默认项：目标分组（含默认分组）由前端显式传入，
      // 服务端契约不变——缺目标仍 422，绝不悄悄挪数据。
      const target = await this.get(query.targetGroupId);
      const moved = await this.prisma.task.updateMany({
        where: { groupId: id },
        data: { groupId: target.id, updatedAt: nowSql() },
      });
      affected = moved.count;
    } else {
      const childCount = await this.prisma.task.count({ where: { groupId: id } });
      if (childCount > 0) {
        const parents = await this.prisma.task.count({
          where: { groupId: id, children: { some: {} } },
        });
        if (parents > 0) {
          throw new ApiException('ILLEGAL_TRANSITION', '分组下存在带子任务的任务，请先处理或改用迁移');
        }
      }
      const deleted = await this.prisma.task.deleteMany({ where: { groupId: id } });
      affected = deleted.count;
    }
    await this.prisma.group.delete({ where: { id } });
    await this.audit.record({
      actorType: 'user',
      action: 'group_change',
      targetType: 'group',
      targetId: id,
      before: { name: row.name },
      after: { deleted: true, strategy: query.strategy, affected_tasks: affected },
    });
    return { id, deleted: true, strategy: query.strategy, affected_tasks: affected };
  }

  private async get(id: string): Promise<Group> {
    const row = await this.prisma.group.findUnique({ where: { id } });
    if (!row) throw new ApiException('NOT_FOUND', `分组 ${id} 不存在`);
    return row;
  }

  private async assertNameFree(name: string, excludeId?: string): Promise<void> {
    const rows = await this.prisma.group.findMany({ where: { name } });
    if (rows.some((row) => row.id !== excludeId)) {
      throw new ApiException('VALIDATION_FAILED', `分组名「${name}」已存在`, [
        { path: 'name', code: 'duplicate_name', message: '分组名不能重复' },
      ]);
    }
  }

  /** §5.5 / §20.1-1：活跃分组达到 50 时拒绝创建（归档分组不占额；归档本身属 W4）。 */
  private async assertLimitFree(): Promise<void> {
    const active = await this.prisma.group.count({ where: { status: 'ACTIVE' } });
    if (active >= GROUP_LIMIT) {
      throw new ApiException(
        'GROUP_LIMIT_REACHED',
        `分组数量已达上限 ${GROUP_LIMIT} 个，请先删除不用的分组`,
        undefined,
        { limit: GROUP_LIMIT, active },
      );
    }
  }
}
