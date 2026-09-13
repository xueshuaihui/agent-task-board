import { Module, type MiddlewareConsumer, NestModule } from '@nestjs/common';
import { ArtifactSignService } from './artifact-sign.service';
import { ArtifactsController } from './artifacts.controller';
import { ArtifactsService } from './artifacts.service';
import { SignedResourceMiddleware } from './signed-resource.middleware';

@Module({
  controllers: [ArtifactsController],
  providers: [ArtifactsService, ArtifactSignService],
  exports: [ArtifactsService, ArtifactSignService],
})
export class ArtifactsModule implements NestModule {
  configure(consumer: MiddlewareConsumer): void {
    // 只对签名 URL 生效；不带 exp/n/s 的请求原样交给守卫按 Authorization 判。
    consumer.apply(SignedResourceMiddleware).forRoutes(ArtifactsController);
  }
}
