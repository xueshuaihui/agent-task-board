import { Body, Controller, Get, Patch } from '@nestjs/common';
import { settingsPatchSchema } from '../contract/schemas';
import { AuthScope } from '../auth/auth.scope';
import { zod } from '../infra/zod.pipe';
import { SettingsApiService } from './settings-api.service';

/**
 * 13 章只有这两条设置接口。备份相关三条（`POST /settings/backup`、
 * `GET /settings/backups`、`POST /settings/backups/{name}/restore`）属 ATB-3，
 * 它们的路径前缀在这里，实现不在，免得两处注册。
 */
@Controller('api/v1/settings')
@AuthScope('ui')
export class SettingsApiController {
  constructor(private readonly settings: SettingsApiService) {}

  /** 返回 20.9 全键的当前值（扁平 map），未写过的键即默认值。 */
  @Get()
  all() {
    return this.settings.all();
  }

  @Patch()
  patch(@Body(zod(settingsPatchSchema)) body: Record<string, unknown>) {
    return this.settings.patch(body);
  }
}
