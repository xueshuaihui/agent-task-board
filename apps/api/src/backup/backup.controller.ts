import { Controller, Get, Param, Post } from '@nestjs/common';
import type { BackupListResult, BackupCreated, RestoreResult } from './backup.service';
import { BackupService } from './backup.service';

/**
 * 13 章「Token / 设置接口」表里的备份三行，全部只在 UI 凭证组下可达
 * （15 章：Agent Token 调不到备份恢复）。
 */
@Controller('api/v1/settings')
export class BackupController {
  constructor(private readonly backups: BackupService) {}

  @Post('backup')
  backup(): Promise<BackupCreated> {
    return this.backups.create();
  }

  /** 设置页备份 Tab 的一次请求：列表 + 总占用 + 目录（8.5）。 */
  @Get('backups')
  list(): BackupListResult & { backup_dir: string } {
    return { ...this.backups.list(), backup_dir: this.backups.dir() };
  }

  @Post('backups/:name/restore')
  restore(@Param('name') name: string): Promise<RestoreResult> {
    return this.backups.restore(name);
  }
}
