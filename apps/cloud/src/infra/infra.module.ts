import { Global, Module } from '@nestjs/common';
import { PrismaService } from './prisma.service';
import { HealthController } from './health.controller';

/** PrismaService 全局共享：auth/market 都注入同一个实例（单写连接收敛）。 */
@Global()
@Module({
  controllers: [HealthController],
  providers: [PrismaService],
  exports: [PrismaService],
})
export class InfraModule {}
