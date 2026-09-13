import { Module } from '@nestjs/common';
import { BackupModule } from '../backup/backup.module';
import { DataController } from './data.controller';
import { DataService } from './data.service';
import { ImportService } from './import.service';

/** 6.12 导入导出。依赖 BackupModule：6.12.2 要求真正导入前先落一个手动备份。 */
@Module({
  imports: [BackupModule],
  controllers: [DataController],
  providers: [DataService, ImportService],
})
export class DataModule {}
