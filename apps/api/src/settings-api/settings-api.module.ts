import { Module } from '@nestjs/common';
import { SettingsApiController } from './settings-api.controller';
import { SettingsApiService } from './settings-api.service';

@Module({
  controllers: [SettingsApiController],
  providers: [SettingsApiService],
  exports: [SettingsApiService],
})
export class SettingsApiModule {}
