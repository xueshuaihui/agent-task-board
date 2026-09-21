import { Module } from '@nestjs/common';
import { BreakdownService } from './breakdown.service';

/**
 * v0.0.4 W7 需求拆解模块。本片只有服务层：REST 端点（/api/v1/breakdown/*，§16.2）
 * 由下一切片（W7-a2）加 controller，MCP board.* 工具由 W8 接入。
 */
@Module({
  providers: [BreakdownService],
  exports: [BreakdownService],
})
export class BreakdownModule {}
