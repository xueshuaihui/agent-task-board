import { Body, Controller, Delete, Get, Patch, Post, Query } from '@nestjs/common';
import { Param } from '@nestjs/common';
import { Auth, AuthScope, type RequestAuth } from '../auth/auth.scope';
import { zod } from '../infra/zod.pipe';
import {
  projectCreateSchema,
  projectDeleteQuerySchema,
  projectPatchSchema,
  type ProjectCreateInput,
  type ProjectDeleteQuery,
  type ProjectPatchInput,
} from './project.dto';
import { ProjectsService, type ProjectDeleteResult, type ProjectDto } from './projects.service';

/** 0919：项目 CRUD，全部 UI 凭证组、按账号隔离。 */
@Controller('api/v1/projects')
@AuthScope('ui')
export class ProjectsController {
  constructor(private readonly projects: ProjectsService) {}

  @Get()
  list(@Auth() auth: RequestAuth) {
    return this.projects.list(this.ui(auth).accountId);
  }

  @Post()
  create(@Body(zod(projectCreateSchema)) body: ProjectCreateInput, @Auth() auth: RequestAuth): Promise<ProjectDto> {
    return this.projects.create(this.ui(auth).accountId, body);
  }

  @Patch(':id')
  patch(
    @Param('id') id: string,
    @Body(zod(projectPatchSchema)) body: ProjectPatchInput,
    @Auth() auth: RequestAuth,
  ): Promise<ProjectDto> {
    return this.projects.patch(this.ui(auth).accountId, id, body);
  }

  @Delete(':id')
  remove(
    @Param('id') id: string,
    @Query(zod(projectDeleteQuerySchema)) query: ProjectDeleteQuery,
    @Auth() auth: RequestAuth,
  ): Promise<ProjectDeleteResult> {
    return this.projects.remove(this.ui(auth).accountId, id, query);
  }

  private ui(auth: RequestAuth): Extract<RequestAuth, { kind: 'ui' }> {
    if (auth.kind !== 'ui') throw new Error('unreachable: controller is ui-scoped');
    return auth;
  }
}
