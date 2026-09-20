import { Module } from '@nestjs/common';
import { PrefsController } from './prefs.controller';
import { GroupsController } from './groups.controller';
import { GroupsService } from './groups.service';

@Module({
  controllers: [GroupsController, PrefsController],
  providers: [GroupsService],
})
export class GroupsModule {}
