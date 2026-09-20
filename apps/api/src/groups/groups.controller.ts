import { Body, Controller, Delete, Get, Param, Patch, Post, Query } from '@nestjs/common';
import { AuthScope } from '../auth/auth.scope';
import { zod } from '../infra/zod.pipe';
import {
  groupCreateSchema,
  groupDeleteQuerySchema,
  groupPatchSchema,
  type GroupCreateInput,
  type GroupDeleteQuery,
  type GroupPatchInput,
} from './group.dto';
import { GroupsService, type GroupDeleteResult, type GroupDto } from './groups.service';

/**
 * v0.0.4 W1b：分组 CRUD（存量「项目」改名迁移，需求.md §21.1），全部 UI 凭证组
 * （v0.0.4 W1a：本地单用户，无账号隔离）。路径见 §16.2 `/api/v1/groups`。
 */
@Controller('api/v1/groups')
@AuthScope('ui')
export class GroupsController {
  constructor(private readonly groups: GroupsService) {}

  @Get()
  list() {
    return this.groups.list();
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

  @Delete(':id')
  remove(
    @Param('id') id: string,
    @Query(zod(groupDeleteQuerySchema)) query: GroupDeleteQuery,
  ): Promise<GroupDeleteResult> {
    return this.groups.remove(id, query);
  }
}
