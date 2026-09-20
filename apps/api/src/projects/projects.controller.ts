import { Body, Controller, Delete, Get, Patch, Post, Query } from '@nestjs/common';
import { Param } from '@nestjs/common';
import { AuthScope } from '../auth/auth.scope';
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

/** 0919：项目 CRUD，全部 UI 凭证组（v0.0.4 W1a：本地单用户，无账号隔离）。 */
@Controller('api/v1/projects')
@AuthScope('ui')
export class ProjectsController {
  constructor(private readonly projects: ProjectsService) {}

  @Get()
  list() {
    return this.projects.list();
  }

  @Post()
  create(@Body(zod(projectCreateSchema)) body: ProjectCreateInput): Promise<ProjectDto> {
    return this.projects.create(body);
  }

  @Patch(':id')
  patch(
    @Param('id') id: string,
    @Body(zod(projectPatchSchema)) body: ProjectPatchInput,
  ): Promise<ProjectDto> {
    return this.projects.patch(id, body);
  }

  @Delete(':id')
  remove(
    @Param('id') id: string,
    @Query(zod(projectDeleteQuerySchema)) query: ProjectDeleteQuery,
  ): Promise<ProjectDeleteResult> {
    return this.projects.remove(id, query);
  }
}
