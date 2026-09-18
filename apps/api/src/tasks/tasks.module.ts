import { Module } from '@nestjs/common';
import { ArtifactsModule } from '../artifacts/artifacts.module';
import { SkillsModule } from '../skills/skills.module';
import { RunsController, TasksController } from './tasks.controller';
import { TasksService } from './tasks.service';

@Module({
  // 删除任务要连产物目录一起删（4.3.1 规则 4），产物侧的路径校验与清理只有一份，所以是
  // tasks → artifacts 的单向依赖（artifacts 不认识 tasks，无环）。
  imports: [ArtifactsModule, SkillsModule],
  controllers: [TasksController, RunsController],
  providers: [TasksService],
  exports: [TasksService],
})
export class TasksModule {}
