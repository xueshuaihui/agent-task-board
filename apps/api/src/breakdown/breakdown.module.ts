import { Module } from '@nestjs/common';
import { BreakdownController } from './breakdown.controller';
import { BreakdownService } from './breakdown.service';

/**
 * v0.0.4 W7 需求拆解模块：服务层 + REST 端点（/api/v1/breakdown/*，§16.2 确认页面）。
 * MCP board.* 工具（Agent 面）在 McpModule 注入本模块导出的 BreakdownService。
 */
@Module({
  imports: [],
  controllers: [BreakdownController],
  providers: [BreakdownService],
  exports: [BreakdownService],
})
export class BreakdownModule {}
