import { Body, Controller, Get, Param, Post, Query } from '@nestjs/common';
import { z } from 'zod';
import {
  clientEntryInstallSchema,
  clientEntryPlanSchema,
  clientEntrySelfTestQuerySchema,
  clientEntryUninstallSchema,
  clientEntryVerifySchema,
  type ClientEntryInstallInput,
  type ClientEntryPlanInput,
  type ClientEntrySelfTestQuery,
  type ClientEntryUninstallInput,
  type ClientEntryVerifyInput,
} from '../contract/client-entry';
import { AuthScope } from '../auth/auth.scope';
import { zod } from '../infra/zod.pipe';
import { ClientEntryService } from './client-entry.service';

/** 概览的唯一查询参数；空串等价于「没选工作区」，由 service 统一降级为用户级。 */
const overviewQuerySchema = z.object({
  workspace: z.string().trim().optional(),
});
type OverviewQuery = z.infer<typeof overviewQuerySchema>;

/**
 * 设置 → 客户端入口（v0.0.4 W9）的六条 UI 路由。
 * 全部走 UI 凭证组：Agent Token 调过来是 403，台账与自测信息只给本地用户看。
 */
@Controller('api/v1/client-entries')
@AuthScope('ui')
export class ClientEntryController {
  constructor(private readonly entries: ClientEntryService) {}

  @Get()
  overview(@Query(zod(overviewQuerySchema)) query: OverviewQuery) {
    return this.entries.overview(query.workspace);
  }

  @Get('self-test')
  selfTest(@Query(zod(clientEntrySelfTestQuerySchema)) query: ClientEntrySelfTestQuery) {
    return this.entries.selfTest(query);
  }

  @Post('plan')
  plan(@Body(zod(clientEntryPlanSchema)) body: ClientEntryPlanInput) {
    return this.entries.plan(body);
  }

  @Post('install')
  install(@Body(zod(clientEntryInstallSchema)) body: ClientEntryInstallInput) {
    return this.entries.install(body);
  }

  @Post('verify')
  verify(@Body(zod(clientEntryVerifySchema)) body: ClientEntryVerifyInput) {
    return this.entries.verify(body);
  }

  /** 路径里的 id 由 service 查台账；`confirm: true` 由 schema 强制，避免误触删除。 */
  @Post(':id/uninstall')
  uninstall(
    @Param('id') id: string,
    @Body(zod(clientEntryUninstallSchema)) _body: ClientEntryUninstallInput,
  ) {
    return this.entries.uninstall(id);
  }
}
