import { Module } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { InfraModule } from '../infra/infra.module';
import { AuthGuard } from './auth.guard';

/**
 * v0.0.4 W1a：auth 只剩全局凭证守卫（UI 会话 Token + Agent Bearer Token）。
 * 账号语义（登录/注册/多账号切换/jwt/密码）已随账号体系一并移除。
 */
@Module({
  imports: [InfraModule],
  providers: [Reflector, AuthGuard],
  exports: [AuthGuard],
})
export class AuthModule {}
