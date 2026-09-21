import { Controller, Get, Param, Post } from '@nestjs/common';
import { AuthScope } from '../auth/auth.scope';
import { BreakdownService } from './breakdown.service';

/**
 * v0.0.4 W7 拆解 REST 端点（PRD §16.2「拆解」小节四行，逐一对应）：
 *   GET  /api/v1/breakdown/sessions        会话列表
 *   GET  /api/v1/breakdown/sessions/{id}   会话详情（session + drafts + progress，确认页数据源）
 *   POST /api/v1/breakdown/sessions/{id}/confirm  确认创建（§7.8 单事务全成或全滚）
 *   POST /api/v1/breakdown/sessions/{id}/cancel   取消
 *
 * 全部 UI 凭证组：begin/进度/草案/完成是 Agent 面（§16.1 board.* MCP 工具），
 * REST 只覆盖用户在确认页上的读与决策；Agent Token 调这里由全局守卫回 FORBIDDEN。
 * 业务全在 BreakdownService，本文件零逻辑（错误语义 13 章由异常过滤器统一兜底）。
 */
@Controller('api/v1/breakdown')
@AuthScope('ui')
export class BreakdownController {
  constructor(private readonly breakdown: BreakdownService) {}

  @Get('sessions')
  list() {
    return this.breakdown.list();
  }

  @Get('sessions/:id')
  detail(@Param('id') id: string) {
    return this.breakdown.get(id);
  }

  @Post('sessions/:id/confirm')
  confirm(@Param('id') id: string) {
    return this.breakdown.confirm(id);
  }

  @Post('sessions/:id/cancel')
  cancel(@Param('id') id: string) {
    return this.breakdown.cancel(id);
  }
}
