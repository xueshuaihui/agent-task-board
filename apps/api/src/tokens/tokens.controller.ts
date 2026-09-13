import { Body, Controller, Delete, Get, Param, Post } from '@nestjs/common';
import { tokenCreateSchema, type TokenCreateInput } from '../contract/schemas';
import { AuthScope } from '../auth/auth.scope';
import { zod } from '../infra/zod.pipe';
import { TokensService } from './tokens.service';

/**
 * 13 章「Token / 设置接口」的三条 Token 路由。15 章把「配置 Token」判为用户专属，
 * 所以三条都显式标 UI 凭证组（Agent Token 调过来是 403，不是 401）。
 * 没有 PATCH：13 章不提供改名，也没有「重新启用」。
 */
@Controller('api/v1/tokens')
@AuthScope('ui')
export class TokensController {
  constructor(private readonly tokens: TokensService) {}

  @Get()
  list() {
    return this.tokens.list();
  }

  @Post()
  issue(@Body(zod(tokenCreateSchema)) body: TokenCreateInput) {
    return this.tokens.issue(body);
  }

  @Delete(':id')
  revoke(@Param('id') id: string) {
    return this.tokens.revoke(id);
  }
}
