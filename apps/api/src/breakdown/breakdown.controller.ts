import { Body, Controller, Delete, Get, Param, Patch, Post } from '@nestjs/common';
import { AuthScope } from '../auth/auth.scope';
import { BreakdownService, type BreakdownDraftInput } from './breakdown.service';

/**
 * v0.0.4 W7 拆解 REST 端点（PRD §16.2「拆解」小节四行，逐一对应）：
 *   GET  /api/v1/breakdown/sessions        会话列表
 *   GET  /api/v1/breakdown/sessions/{id}   会话详情（session + drafts + progress，确认页数据源）
 *   POST /api/v1/breakdown/sessions/{id}/confirm  确认创建（§7.8 单事务全成或全滚）
 *   POST /api/v1/breakdown/sessions/{id}/cancel   取消
 *
 * W7 遗留 b3 增补（§7.4 编辑能力 / 条款 81「可改」，PRD §16.2 拆解小节的用户侧写延伸）：
 *   POST   /api/v1/breakdown/sessions/{id}/drafts          添加任务（ref 可省略，服务端取号）
 *   PATCH  /api/v1/breakdown/sessions/{id}/drafts/{ref}    改标题/描述/优先级/技能/验收/依赖边集合
 *   DELETE /api/v1/breakdown/sessions/{id}/drafts/{ref}    删除任务（级联清悬空 depends_on）
 *   POST   /api/v1/breakdown/sessions/{id}/drafts/{ref}/regenerate
 *                                                          重新生成=重置待 Agent 重报（条款81）
 * 四条仅 reviewing 可写（§7.7），与 confirm 同款 status 条件 UPDATE 并发守卫。
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

  @Post('sessions/:id/drafts')
  addDraft(@Param('id') id: string, @Body() body: Partial<BreakdownDraftInput>) {
    return this.breakdown.userAddDraft(id, body ?? {});
  }

  @Patch('sessions/:id/drafts/:ref')
  updateDraft(
    @Param('id') id: string,
    @Param('ref') ref: string,
    @Body() body: Partial<BreakdownDraftInput>,
  ) {
    return this.breakdown.userUpdateDraft(id, decodeURIComponent(ref), body ?? {});
  }

  @Delete('sessions/:id/drafts/:ref')
  deleteDraft(@Param('id') id: string, @Param('ref') ref: string) {
    return this.breakdown.userDeleteDraft(id, decodeURIComponent(ref));
  }

  @Post('sessions/:id/drafts/:ref/regenerate')
  regenerateDraft(@Param('id') id: string, @Param('ref') ref: string) {
    return this.breakdown.userRegenerateDraft(id, decodeURIComponent(ref));
  }
}
