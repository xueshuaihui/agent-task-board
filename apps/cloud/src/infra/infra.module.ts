import { Global, Module } from '@nestjs/common';
import { PrismaService } from './prisma.service';

/** PrismaService 全局共享：auth/market 都注入同一个实例（单写连接收敛）。 */
@Global()
@Module({
  providers: [PrismaService],
  exports: [PrismaService],
})
export class InfraModule {}
