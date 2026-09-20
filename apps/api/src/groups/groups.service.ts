import { Injectable } from '@nestjs/common';
import type { Group } from '@prisma/client';
import { ApiException } from '../contract/errors';
import { newId } from '../contract/ids';
import { nowSql, toIso } from '../contract/time';
import { AuditService } from '../infra/audit.service';
import { EventsService } from '../infra/events.service';
import { PrismaService } from '../infra/prisma.service';
import type { GroupCreateInput, GroupDeleteQuery, GroupListQuery, GroupPatchInput } from './group.dto';

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
  /** v0.0.4 W4 §5.6/0011：归档时刻；活跃分组恒为 null（反归档清回）。 */
  archived_at: string | null;
  created_at: string | null;
  updated_at: string | null;
  /**
   * v0.0.4 W4 §5.6：列表查询才带（一次 groupBy 顺路算好）——
   * `task_count` 组内全部任务数（归档折叠区的「N 任务」），
   * `unfinished_count` 未完成且未归档的任务数（>0 时归档入口置灰并提示剩余数）。
   */
  task_count?: number;
  unfinished_count?: number;
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
    archived_at: toIso(row.archivedAt),
    created_at: toIso(row.createdAt),
    updated_at: toIso(row.updatedAt),
  };
}

@Injectable()
export class GroupsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly events: EventsService,
  ) {}

  /**
   * §16.2（r3）：默认只列活跃分组（归档组从分组切换器/泳道默认隐藏，§5.6）；
   * `?archived=true` 连归档组一起返回（设置/分组「已归档」区、看板归档折叠区用）。
   * 顺路带 task_count / unfinished_count（§5.6 置灰提示剩余任务数的数据源），两次 groupBy，不逐组查。
   */
  async list(query: GroupListQuery = {}): Promise<{ items: GroupDto[] }> {
    const rows = await this.prisma.group.findMany({
      where: query.archived === 'true' ? {} : { status: 'ACTIVE' },
      orderBy: [{ sort: 'asc' }, { createdAt: 'asc' }],
    });
    const ids = rows.map((row) => row.id);
    const [totals, unfinished] = await Promise.all([
      this.prisma.task.groupBy({
        by: ['groupId'],
        where: { groupId: { in: ids } },
        _count: { _all: true },
      }),
      this.prisma.task.groupBy({
        by: ['groupId'],
        where: { groupId: { in: ids }, status: { not: 'DONE' }, archivedAt: null },
        _count: { _all: true },
      }),
    ]);
    const totalBy = new Map(totals.map((row) => [row.groupId, Number(row._count._all)]));
    const unfinishedBy = new Map(unfinished.map((row) => [row.groupId, Number(row._count._all)]));
    return {
      items: rows.map((row) => ({
        ...toDto(row),
        task_count: totalBy.get(row.id) ?? 0,
        unfinished_count: unfinishedBy.get(row.id) ?? 0,
      })),
    };
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

  /**
   * 编辑分组。v0.0.4 W4 §5.6：`status` 变化一律转调 archive()/unarchive() 的专门语义
   * （全部完成校验、默认组保护、反归档上限校验、archived_at 对账、WS/审计），
   * 不再直写 status——否则两条入口会漂移出 status 与 archived_at 不一致的行。
   */
  async patch(id: string, input: GroupPatchInput): Promise<GroupDto> {
    const row = await this.get(id);
    if (input.name !== undefined) await this.assertNameFree(input.name, id);
    if (input.status !== undefined && input.status !== row.status) {
      if (input.status === 'ARCHIVED') await this.archive(id);
      else await this.unarchive(id);
    }
    const { status: _status, ...rest } = input;
    if (Object.keys(rest).length > 0) {
      // is_default 不在 groupPatchSchema 里：PATCH 改不到它本就是契约的一部分
      // （预置标记只认迁移植入，不认任何写入口），这里多余的数据面兜底都不需要。
      await this.prisma.group.update({
        where: { id },
        data: {
          ...(rest.name === undefined ? {} : { name: rest.name }),
          ...(rest.color === undefined ? {} : { color: rest.color }),
          ...(rest.icon === undefined ? {} : { icon: rest.icon }),
          ...(rest.description === undefined ? {} : { description: rest.description }),
          ...(rest.sort === undefined ? {} : { sort: rest.sort }),
          updatedAt: nowSql(),
        },
      });
      await this.audit.record({
        actorType: 'user',
        action: 'group_change',
        targetType: 'group',
        targetId: id,
        after: { ...rest },
      });
    }
    return toDto(await this.get(id));
  }

  /**
   * §5.6 归档（仅手动，POST /groups/:id/archive）：
   * - 默认分组不可归档（GROUP_DEFAULT_PROTECTED，与 W1-D1 的防御 PATCH 同码）；
   * - 组内全部任务（含需求及其子任务，逐行统计）均已 DONE 或已归档，否则
   *   GROUP_NOT_ALL_DONE + context.remaining（前端据此提示剩余任务数）；
   * - 归档不移动、不删除任务；分组转只读的写入口拦截在任务侧 assertGroup；
   * - 归档分组不占 50 上限（assertLimitFree 只数 ACTIVE，口径已核）；
   * - 幂等：已归档直接回当前值。
   */
  async archive(id: string): Promise<GroupDto> {
    const row = await this.get(id);
    if (row.isDefault === 1) {
      throw new ApiException('GROUP_DEFAULT_PROTECTED', '默认分组不可归档');
    }
    if (row.status === 'ARCHIVED') return toDto(row);
    const remaining = await this.unfinishedTaskCount(id);
    if (remaining > 0) {
      throw new ApiException(
        'GROUP_NOT_ALL_DONE',
        `分组「${row.name}」还有 ${remaining} 个任务未完成或归档，全部处理完才能归档`,
        undefined,
        { group_id: id, remaining },
      );
    }
    const archivedAt = nowSql();
    await this.prisma.group.update({
      where: { id },
      data: { status: 'ARCHIVED', archivedAt, updatedAt: archivedAt },
    });
    await this.audit.record({
      actorType: 'user',
      action: 'group_archive',
      targetType: 'group',
      targetId: id,
      before: { status: 'ACTIVE', archived_at: null },
      after: { status: 'ARCHIVED', archived_at: toIso(archivedAt) },
    });
    // §5.6 r3：WS 推 group.archived；与其余 WS 事件同一口径，只当失效信号、载荷带分组 id。
    this.events.emit('group.archived', { id });
    return toDto(await this.get(id));
  }

  /**
   * §5.6 反归档（POST /groups/:id/unarchive）：恢复活跃、重新占用 50 上限——
   * 上限已满时不允许恢复（GROUP_LIMIT_REACHED）；取消归档后组内任务重新进入
   * Agent 领取候选（claim 的排除谓词按 groups.status 取值，自动恢复）。
   * 幂等：活跃分组直接回当前值。
   */
  async unarchive(id: string): Promise<GroupDto> {
    const row = await this.get(id);
    if (row.status !== 'ARCHIVED') return toDto(row);
    await this.assertLimitFree('恢复');
    const restoredAt = nowSql();
    await this.prisma.group.update({
      where: { id },
      data: { status: 'ACTIVE', archivedAt: null, updatedAt: restoredAt },
    });
    await this.audit.record({
      actorType: 'user',
      action: 'group_unarchive',
      targetType: 'group',
      targetId: id,
      before: { status: 'ARCHIVED', archived_at: toIso(row.archivedAt) },
      after: { status: 'ACTIVE', archived_at: null },
    });
    this.events.emit('group.unarchived', { id });
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

  /**
   * §5.6 触发条件：组内「未完成且未归档」的任务数（含需求与其子任务——需求行本身也是
   * 任务，逐行统计即覆盖）。0 才允许归档。
   */
  private async unfinishedTaskCount(groupId: string): Promise<number> {
    return this.prisma.task.count({
      where: { groupId, status: { not: 'DONE' }, archivedAt: null },
    });
  }

  private async assertNameFree(name: string, excludeId?: string): Promise<void> {
    const rows = await this.prisma.group.findMany({ where: { name } });
    if (rows.some((row) => row.id !== excludeId)) {
      throw new ApiException('VALIDATION_FAILED', `分组名「${name}」已存在`, [
        { path: 'name', code: 'duplicate_name', message: '分组名不能重复' },
      ]);
    }
  }

  /**
   * §5.5 / §20.1-1：活跃分组达到 50 时拒绝新建；W4 §5.6 同口径复用给反归档
   * （恢复后重新占额，上限已满时不允许恢复）。
   */
  private async assertLimitFree(operation: '新建' | '恢复' = '新建'): Promise<void> {
    const active = await this.prisma.group.count({ where: { status: 'ACTIVE' } });
    if (active >= GROUP_LIMIT) {
      throw new ApiException(
        'GROUP_LIMIT_REACHED',
        `分组数量已达上限 ${GROUP_LIMIT} 个，${operation === '恢复' ? '无法取消归档，' : ''}请先删除不用的分组`,
        undefined,
        { limit: GROUP_LIMIT, active, operation },
      );
    }
  }
}
