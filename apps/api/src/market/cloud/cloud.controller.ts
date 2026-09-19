import { Body, Controller, Get, Post } from '@nestjs/common';
import { Auth, AuthScope, type RequestAuth } from '../../auth/auth.scope';
import { zod } from '../../infra/zod.pipe';
import { CloudMarketService } from './cloud-market.service';
import { cloudConnectSchema, cloudPublishSchema, type CloudConnectInput, type CloudPublishInput } from '../market.dto';
import { MarketService } from '../market.service';

/**
 * 0919 服务端市场对接层（设置页「服务端市场」区块 + 发布同步到服务端入口）：
 * - POST   /api/v1/market/cloud/connect     {url, username, password} → 服务端向服务端 login 校验并保存
 * - POST   /api/v1/market/cloud/disconnect
 * - GET    /api/v1/market/cloud/status      → {connected, url, username}
 * - POST   /api/v1/market/cloud/publish     {skill_id, category, license, compatible_clients, visibility}
 *
 * 服务端登录失败 / 服务端不可达一律 502 CLOUD_ERROR，message 透传服务端原文。
 */
@Controller('api/v1/market/cloud')
@AuthScope('ui')
export class CloudMarketController {
  constructor(
    private readonly cloud: CloudMarketService,
    private readonly market: MarketService,
  ) {}

  @Post('connect')
  connect(@Body(zod(cloudConnectSchema)) body: CloudConnectInput, @Auth() auth: RequestAuth) {
    void auth;
    return this.cloud.connect(body);
  }

  @Post('disconnect')
  disconnect(@Auth() auth: RequestAuth) {
    void auth;
    return this.cloud.disconnect();
  }

  @Get('status')
  status(@Auth() auth: RequestAuth) {
    void auth;
    return this.cloud.status();
  }

  @Post('publish')
  publish(@Body(zod(cloudPublishSchema)) body: CloudPublishInput, @Auth() auth: RequestAuth) {
    return this.market.publishToCloud(body, auth.accountId);
  }
}
