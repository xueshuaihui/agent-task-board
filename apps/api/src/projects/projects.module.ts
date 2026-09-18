import { Module } from '@nestjs/common';
import { PrefsController } from './prefs.controller';
import { ProjectsController } from './projects.controller';
import { ProjectsService } from './projects.service';

@Module({
  controllers: [ProjectsController, PrefsController],
  providers: [ProjectsService],
})
export class ProjectsModule {}
