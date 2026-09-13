import { Body, Controller, Delete, Get, Param, Patch, Post, Query } from '@nestjs/common';
import type { CommentType } from '../contract/enums';
import {
  batchIdsSchema,
  batchTagsSchema,
  batchTransitionSchema,
  boardQuerySchema,
  commentSchema,
  commentsQuerySchema,
  dependencyCreateSchema,
  listQuerySchema,
  paginationSchema,
  reviewSchema,
  stopSchema,
  taskCreateSchema,
  taskPatchSchema,
  transitionSchema,
  type BatchIdsInput,
  type BatchTagsInput,
  type BatchTransitionInput,
  type BoardQuery,
  type CommentInput,
  type CommentsQuery,
  type DependencyCreateInput,
  type ListQuery,
  type Pagination,
  type ReviewInput,
  type StopInput,
  type TaskCreateInput,
  type TaskPatchInput,
  type TransitionInput,
} from '../contract/schemas';
import { Auth, AuthScope, type RequestAuth } from '../auth/auth.scope';
import { zod } from '../infra/zod.pipe';
import { TasksService } from './tasks.service';

/** 「评论」Tab 的默认类型：日志走 runs/:id/logs，不混进人写的评论里。 */
const DEFAULT_COMMENT_TYPES: CommentType[] = ['comment', 'status_change'];

/**
 * 13 章的用户侧任务接口，全部只在 UI 凭证组下可达（AuthGuard 默认 scope）。
 * 声明顺序即路由匹配顺序：`tasks/batch/*` 必须排在 `tasks/:id/*` 之前，
 * 否则 `POST tasks/batch/transition` 会被当成 `:id = 'batch'` 抢走。
 */
@Controller('api/v1')
export class TasksController {
  constructor(private readonly tasks: TasksService) {}

  @Get('board')
  board(@Query(zod(boardQuerySchema)) query: BoardQuery) {
    return this.tasks.board(query);
  }

  @Get('tags')
  async tags() {
    return { tags: await this.tasks.tags() };
  }

  @Get('tasks')
  list(@Query(zod(listQuerySchema)) query: ListQuery) {
    return this.tasks.list(query);
  }

  @Post('tasks')
  create(@Body(zod(taskCreateSchema)) body: TaskCreateInput, @Auth() auth: RequestAuth) {
    return this.tasks.create(body, auth);
  }

  @Post('tasks/batch/transition')
  batchTransition(@Body(zod(batchTransitionSchema)) body: BatchTransitionInput) {
    return this.tasks.batchTransition(body.ids, body.to);
  }

  @Post('tasks/batch/archive')
  batchArchive(@Body(zod(batchIdsSchema)) body: BatchIdsInput) {
    return this.tasks.batchArchive(body.ids);
  }

  @Post('tasks/batch/tags')
  batchTags(@Body(zod(batchTagsSchema)) body: BatchTagsInput) {
    return this.tasks.batchTags(body.ids, body.add, body.remove);
  }

  /** 13 章认证表里唯一的「任一即可」：详情是只读，Agent 也要能查。 */
  @Get('tasks/:id')
  @AuthScope('any')
  detail(@Param('id') id: string) {
    return this.tasks.getDetail(id);
  }

  @Patch('tasks/:id')
  patch(@Param('id') id: string, @Body(zod(taskPatchSchema)) body: TaskPatchInput) {
    return this.tasks.patch(id, body);
  }

  @Delete('tasks/:id')
  remove(@Param('id') id: string) {
    return this.tasks.remove(id);
  }

  @Post('tasks/:id/transition')
  transition(@Param('id') id: string, @Body(zod(transitionSchema)) body: TransitionInput) {
    return this.tasks.transition(id, body.to, body.comment);
  }

  @Post('tasks/:id/stop')
  stop(@Param('id') id: string, @Body(zod(stopSchema)) body: StopInput) {
    return this.tasks.stop(id, body.reason);
  }

  @Post('tasks/:id/review')
  review(@Param('id') id: string, @Body(zod(reviewSchema)) body: ReviewInput) {
    return this.tasks.submitReview(id, body);
  }

  @Post('tasks/:id/comments')
  comment(
    @Param('id') id: string,
    @Body(zod(commentSchema)) body: CommentInput,
    @Auth() auth: RequestAuth,
  ) {
    return this.tasks.addComment(id, body.content, body.run_id, auth);
  }

  @Get('tasks/:id/comments')
  listComments(
    @Param('id') id: string,
    @Query(zod(commentsQuerySchema)) query: CommentsQuery,
  ) {
    return this.tasks.taskComments(
      id,
      query.type ?? DEFAULT_COMMENT_TYPES,
      query.page,
      query.page_size,
    );
  }

  @Get('tasks/:id/runs')
  runs(@Param('id') id: string) {
    return this.tasks.runs(id);
  }

  @Get('tasks/:id/reviews')
  reviews(@Param('id') id: string) {
    return this.tasks.taskReviews(id);
  }

  @Get('tasks/:id/dependencies')
  dependencies(@Param('id') id: string) {
    return this.tasks.dependencies(id);
  }

  @Post('tasks/:id/dependencies')
  addDependency(
    @Param('id') id: string,
    @Body(zod(dependencyCreateSchema)) body: DependencyCreateInput,
  ) {
    return this.tasks.addDependency(id, body.depends_on, body.type);
  }

  @Delete('tasks/:id/dependencies/:depId')
  removeDependency(@Param('id') id: string, @Param('depId') depId: string) {
    return this.tasks.removeDependency(id, depId);
  }

  @Post('tasks/:id/pin')
  pin(@Param('id') id: string) {
    return this.tasks.setPinned(id, true);
  }

  @Delete('tasks/:id/pin')
  unpin(@Param('id') id: string) {
    return this.tasks.setPinned(id, false);
  }

  @Post('tasks/:id/archive')
  archive(@Param('id') id: string) {
    return this.tasks.archive(id);
  }

  @Post('tasks/:id/restore')
  restore(@Param('id') id: string) {
    return this.tasks.restore(id);
  }
}

@Controller('api/v1')
export class RunsController {
  constructor(private readonly tasks: TasksService) {}

  @Get('runs/:id/logs')
  logs(@Param('id') id: string, @Query(zod(paginationSchema)) page: Pagination) {
    return this.tasks.runLogs(id, page.page, page.page_size);
  }
}
