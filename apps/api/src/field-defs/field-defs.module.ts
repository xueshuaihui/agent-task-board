import { Module } from '@nestjs/common';
import { FieldDefsController } from './field-defs.controller';
import { FieldDefsService } from './field-defs.service';

@Module({
  controllers: [FieldDefsController],
  providers: [FieldDefsService],
  exports: [FieldDefsService],
})
export class FieldDefsModule {}
