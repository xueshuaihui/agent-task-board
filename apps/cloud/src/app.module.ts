import { Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { AuthGuard } from './auth/auth.guard';
import { AuthModule } from './auth/auth.module';
import { InfraModule } from './infra/infra.module';
import { MarketModule } from './market/market.module';

@Module({
  imports: [InfraModule, AuthModule, MarketModule],
  providers: [{ provide: APP_GUARD, useClass: AuthGuard }],
})
export class AppModule {}
