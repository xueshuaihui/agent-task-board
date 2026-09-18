import { Module } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { InfraModule } from '../infra/infra.module';
import { AccountsController } from './accounts.controller';
import { AccountsService } from './accounts.service';
import { AuthGuard } from './auth.guard';

@Module({
  imports: [InfraModule],
  controllers: [AccountsController],
  providers: [Reflector, AuthGuard, AccountsService],
  exports: [AuthGuard],
})
export class AuthModule {}
