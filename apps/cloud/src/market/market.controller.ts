import { Body, Controller, Delete, Get, Param, Post, Query } from '@nestjs/common';
import { Auth, Public, type RequestAuth } from '../auth/auth.scope';
import { zod } from '../infra/zod.pipe';
import { MarketService } from './market.service';
import {
  marketCommentSchema,
  marketFeedbackRespondSchema,
  marketFeedbackSchema,
  marketFeedbackVerifySchema,
  marketListQuerySchema,
  marketPublishSchema,
  marketPublishVersionSchema,
  marketRatingSchema,
  marketReportSchema,
  type MarketCommentInput,
  type MarketFeedbackInput,
  type MarketFeedbackRespondInput,
  type MarketFeedbackVerifyInput,
  type MarketListQuery,
  type MarketPublishInput,
  type MarketPublishVersionInput,
  type MarketRatingInput,
  type MarketReportInput,
} from './market.dto';

/**
 * 服务端市场：listings 浏览/详情公开可匿名；发布、订阅、评分、评论、反馈需登录。
 * 路由前缀 cloud/v1/market。
 */
@Controller('cloud/v1/market')
export class MarketController {
  constructor(private readonly market: MarketService) {}

  // 浏览/详情（公开）
  @Public()
  @Get('listings')
  list(@Query(zod(marketListQuerySchema)) query: MarketListQuery) {
    return this.market.list(query);
  }

  @Public()
  @Get('listings/:id')
  detail(@Param('id') id: string, @Auth() auth?: RequestAuth) {
    return this.market.detail(id, auth?.accountId);
  }

  // 我的（登录）
  @Get('subscriptions')
  subscriptions(@Auth() auth: RequestAuth) {
    return this.market.subscriptions(auth.accountId);
  }

  @Get('me/publishes')
  myPublishes(@Auth() auth: RequestAuth) {
    return this.market.myPublishes(auth.accountId);
  }

  @Get('me/favorites')
  myFavorites(@Auth() auth: RequestAuth) {
    return this.market.myFavorites(auth.accountId);
  }

  @Get('me/feedbacks')
  myFeedbacks(@Auth() auth: RequestAuth) {
    return this.market.myFeedbacks(auth.accountId);
  }

  // 发布/版本/下线
  @Post('publish')
  publish(@Body(zod(marketPublishSchema)) body: MarketPublishInput, @Auth() auth: RequestAuth) {
    return this.market.publish(body, auth.accountId);
  }

  @Post('listings/:id/versions')
  publishVersion(
    @Param('id') id: string,
    @Body(zod(marketPublishVersionSchema)) body: MarketPublishVersionInput,
    @Auth() auth: RequestAuth,
  ) {
    return this.market.publishVersion(id, body, auth.accountId);
  }

  @Post('listings/:id/delist')
  delist(@Param('id') id: string, @Auth() auth: RequestAuth) {
    return this.market.delist(id, auth.accountId);
  }

  // 订阅
  @Post('listings/:id/subscribe')
  subscribe(@Param('id') id: string, @Auth() auth: RequestAuth) {
    return this.market.subscribe(id, auth.accountId);
  }

  @Post('listings/:id/update')
  pullUpdate(@Param('id') id: string, @Auth() auth: RequestAuth) {
    return this.market.pullUpdate(id, auth.accountId);
  }

  @Delete('listings/:id/subscribe')
  unsubscribe(@Param('id') id: string, @Auth() auth: RequestAuth) {
    return this.market.unsubscribe(id, auth.accountId);
  }

  // 评分/评论/收藏/举报
  @Post('listings/:id/rating')
  rate(
    @Param('id') id: string,
    @Body(zod(marketRatingSchema)) body: MarketRatingInput,
    @Auth() auth: RequestAuth,
  ) {
    return this.market.rate(id, body, auth.accountId);
  }

  @Post('listings/:id/comments')
  comment(
    @Param('id') id: string,
    @Body(zod(marketCommentSchema)) body: MarketCommentInput,
    @Auth() auth: RequestAuth,
  ) {
    return this.market.comment(id, body, auth.accountId);
  }

  @Delete('comments/:commentId')
  deleteComment(@Param('commentId') commentId: string, @Auth() auth: RequestAuth) {
    return this.market.deleteComment(commentId, auth.accountId, auth.role);
  }

  @Post('listings/:id/favorite')
  toggleFavorite(@Param('id') id: string, @Auth() auth: RequestAuth) {
    return this.market.toggleFavorite(id, auth.accountId);
  }

  @Post('listings/:id/report')
  report(
    @Param('id') id: string,
    @Body(zod(marketReportSchema)) body: MarketReportInput,
    @Auth() auth: RequestAuth,
  ) {
    return this.market.report(id, body, auth.accountId);
  }

  // 反馈闭环
  @Post('listings/:id/feedback')
  createFeedback(
    @Param('id') id: string,
    @Body(zod(marketFeedbackSchema)) body: MarketFeedbackInput,
    @Auth() auth: RequestAuth,
  ) {
    return this.market.createFeedback(id, body, auth.accountId);
  }

  @Post('feedbacks/:feedbackId/respond')
  respondFeedback(
    @Param('feedbackId') feedbackId: string,
    @Body(zod(marketFeedbackRespondSchema)) body: MarketFeedbackRespondInput,
    @Auth() auth: RequestAuth,
  ) {
    return this.market.respondFeedback(feedbackId, body, auth.accountId);
  }

  @Post('feedbacks/:feedbackId/verify')
  verifyFeedback(
    @Param('feedbackId') feedbackId: string,
    @Body(zod(marketFeedbackVerifySchema)) body: MarketFeedbackVerifyInput,
    @Auth() auth: RequestAuth,
  ) {
    return this.market.verifyFeedback(feedbackId, body, auth.accountId);
  }
}
