import { Module } from '@nestjs/common';
import { RunsController, TasksController } from './tasks.controller';
import { TasksService } from './tasks.service';

@Module({
  controllers: [TasksController, RunsController],
  providers: [TasksService],
  exports: [TasksService],
})
export class TasksModule {}
