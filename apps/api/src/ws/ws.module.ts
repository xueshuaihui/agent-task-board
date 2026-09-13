import { Module } from '@nestjs/common';
import { WsGateway } from './ws-gateway';

/**
 * EventsService / PrismaService 等都在 InfraModule 的 @Global() 里，这里不用 imports。
 * 网关自己在 onApplicationBootstrap 上挂 upgrade，接线只需要在 AppModule 里 import 本模块。
 */
@Module({
  providers: [WsGateway],
  exports: [WsGateway],
})
export class WsModule {}
