import { Module } from '@nestjs/common';
import { AuditApiController } from './audit-api.controller';
import { AuditQueryService } from './audit-query.service';

@Module({
  controllers: [AuditApiController],
  providers: [AuditQueryService],
  exports: [AuditQueryService],
})
export class AuditApiModule {}
