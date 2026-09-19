import { Module } from '@nestjs/common';
import { MarketController } from './market.controller';
import { MarketService } from './market.service';
import { CloudMarketClient } from './cloud/cloud.client';
import { CloudMarketService } from './cloud/cloud-market.service';
import { CloudMarketController } from './cloud/cloud.controller';

@Module({
  controllers: [MarketController, CloudMarketController],
  providers: [MarketService, CloudMarketClient, CloudMarketService],
  exports: [MarketService],
})
export class MarketModule {}
