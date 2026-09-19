import { Controller, Get } from '@nestjs/common';
import { Public } from '../auth/auth.scope';

/**
 * 探活端点：GET /healthz → { ok, commit }。
 * commit 来自构建期注入的 CLOUD_COMMIT（见 apps/cloud/Dockerfile 的 GIT_REVISION 构建参数），
 * 部署运维用它核对「线上跑的是哪次提交」（与离线包内 BUILD-INFO.txt 一致）。
 */
@Controller('healthz')
export class HealthController {
  @Public()
  @Get()
  healthz() {
    return { ok: true, commit: process.env.CLOUD_COMMIT || 'unknown' };
  }
}
