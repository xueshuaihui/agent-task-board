import { Module } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { InfraModule } from '../infra/infra.module';
import { AuthGuard } from './auth.guard';

@Module({
  imports: [InfraModule],
  providers: [Reflector, AuthGuard],
  exports: [AuthGuard],
})
export class AuthModule {}
