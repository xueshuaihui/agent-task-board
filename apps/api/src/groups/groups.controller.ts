import { Body, Controller, Delete, Get, Param, Patch, Post, Query } from '@nestjs/common';
import { AuthScope } from '../auth/auth.scope';
import { zod } from '../infra/zod.pipe';
import {
  groupCreateSchema,
  groupDeleteQuerySchema,
  groupListQuerySchema,
  groupPatchSchema,
  type GroupCreateInput,
  type GroupDeleteQuery,
  type GroupListQuery,
  type GroupPatchInput,
} from './group.dto';
import { GroupsService, type GroupDeleteResult, type GroupDto } from './groups.service';

/**
 * v0.0.4 W1b：分组 CRUD（存量「项目」改名迁移，需求.md §21.1），全部 UI 凭证组
 * （v0.0.4 W1a：本地单用户，无账号隔离）。路径见 §16.2 `/api/v1/groups`。
 * v0.0.4 W4（§5.6/§16.2）：`?archived=true` 含归档组；专门的归档/反归档端点。
 */
@Controller('api/v1/groups')
@AuthScope('ui')
export class GroupsController {
  constructor(private readonly groups: GroupsService) {}

  @Get()
  list(@Query(zod(groupListQuerySchema)) query: GroupListQuery) {
    return this.groups.list(query);
  }

  @Post()
  create(@Body(zod(groupCreateSchema)) body: GroupCreateInput): Promise<GroupDto> {
    return this.groups.create(body);
  }

  @Patch(':id')
  patch(
    @Param('id') id: string,
    @Body(zod(groupPatchSchema)) body: GroupPatchInput,
  ): Promise<GroupDto> {
    return this.groups.patch(id, body);
  }

  /** §5.6：归档（组内任务全部完成/归档才放行；默认分组拒绝）。 */
  @Post(':id/archive')
  archive(@Param('id') id: string): Promise<GroupDto> {
    return this.groups.archive(id);
  }

  /** §5.6：取消归档（恢复活跃并重新占用 50 上限）。 */
  @Post(':id/unarchive')
  unarchive(@Param('id') id: string): Promise<GroupDto> {
    return this.groups.unarchive(id);
  }

  @Delete(':id')
  remove(
    @Param('id') id: string,
    @Query(zod(groupDeleteQuerySchema)) query: GroupDeleteQuery,
  ): Promise<GroupDeleteResult> {
    return this.groups.remove(id, query);
  }
}
