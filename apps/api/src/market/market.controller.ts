import { Body, Controller, Delete, Get, Param, Post, Query } from '@nestjs/common';
import { Auth, AuthScope, type RequestAuth } from '../auth/auth.scope';
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
  marketReviewSchema,
  type MarketCommentInput,
  type MarketFeedbackInput,
  type MarketFeedbackRespondInput,
  type MarketFeedbackVerifyInput,
  type MarketListQuery,
  type MarketPublishInput,
  type MarketPublishVersionInput,
  type MarketRatingInput,
  type MarketReportInput,
  type MarketReviewInput,
} from './market.dto';

/**
 * 0919 九章服务端市场：listings/评分/评论全局共享；订阅/收藏/反馈/我的按请求账号隔离。
 * Agent Token 属 agent 凭证组，被默认 ui scope 拒绝——市场是纯用户功能。
 */
@Controller('api/v1/market')
@AuthScope('ui')
export class MarketController {
  constructor(private readonly market: MarketService) {}

  // 浏览/详情（9.1/9.2）
  @Get('listings')
  list(@Query(zod(marketListQuerySchema)) query: MarketListQuery, @Auth() auth: RequestAuth) {
    return this.market.list(query, auth.accountId);
  }

  @Get('subscriptions')
  subscriptions(@Auth() auth: RequestAuth) {
    return this.market.subscriptions(auth.accountId);
  }

  @Get('me/publishes')
  myPublishes(@Auth() auth: RequestAuth) {
    return this.market.myPublishes(auth.accountId);
  }

  @Get('me/feedbacks')
  myFeedbacks(@Auth() auth: RequestAuth) {
    return this.market.myFeedbacks(auth.accountId);
  }

  @Get('me/favorites')
  myFavorites(@Auth() auth: RequestAuth) {
    return this.market.myFavorites(auth.accountId);
  }

  @Get('listings/:id')
  detail(@Param('id') id: string, @Auth() auth: RequestAuth) {
    return this.market.detail(id, auth.accountId);
  }

  // 发布/审核/下线/新版本（9.3/9.4）
  @Post('publish')
  publish(@Body(zod(marketPublishSchema)) body: MarketPublishInput, @Auth() auth: RequestAuth) {
    return this.market.publish(body, auth.accountId);
  }

  @Post('listings/:id/review')
  review(
    @Param('id') id: string,
    @Body(zod(marketReviewSchema)) body: MarketReviewInput,
    @Auth() auth: RequestAuth,
  ) {
    return this.market.review(id, body, auth.accountId);
  }

  @Post('listings/:id/delist')
  delist(@Param('id') id: string, @Auth() auth: RequestAuth) {
    return this.market.delist(id, auth.accountId);
  }

  @Post('listings/:id/publish-version')
  publishVersion(
    @Param('id') id: string,
    @Body(zod(marketPublishVersionSchema)) body: MarketPublishVersionInput,
    @Auth() auth: RequestAuth,
  ) {
    return this.market.publishVersion(id, body, auth.accountId);
  }

  // 订阅（9.4/14.1）
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

  // 评分/评论/收藏/举报（9.5）
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
    return this.market.deleteComment(commentId, auth.accountId);
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

  // 反馈闭环（9.5/14.3）
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
