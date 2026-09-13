import { Injectable, type NestMiddleware } from '@nestjs/common';
import type { NextFunction, Request, Response } from 'express';
import { ApiException } from '../contract/errors';
import type { SignedKind } from './artifact-sign.service';
import { ArtifactSignService } from './artifact-sign.service';

/**
 * 签名 URL 的落地点。`<img>`、`iframe` 带不了请求头（13 章「资源型端点例外」），
 * 而全局 AuthGuard 只认 `Authorization`——`src/auth/**` 归别人维护、我不能改，
 * 所以「校验签名 → 换成进程内的 UI 凭证」这一步放在中间件里做，它跑在守卫之前。
 *
 * 查询串里从头到尾没有 UI Token，只有一个 HMAC 委托值；`ATB_UI_TOKEN` 只在进程内出现，
 * 不进响应体也不进日志。签名一次性核销，重放到这里就已经失效。
 */
@Injectable()
export class SignedResourceMiddleware implements NestMiddleware {
  constructor(private readonly sign: ArtifactSignService) {}

  use(req: Request, res: Response, next: NextFunction): void {
    const query = (req.query ?? {}) as Record<string, unknown>;
    if (query.exp === undefined && query.n === undefined && query.s === undefined) return next();

    const url = (req.originalUrl ?? req.url).split('?')[0] ?? '';
    const kind: SignedKind | null = url.endsWith('/thumbnail')
      ? 'thumbnail'
      : url.endsWith('/raw')
        ? 'raw'
        : null;
    if (!kind) return next();

    const id = String((req.params as Record<string, string>).id ?? '');
    try {
      this.sign.consume(id, kind, query);
    } catch (error) {
      if (error instanceof ApiException) {
        res.status(error.status).json(error.toBody());
        return;
      }
      throw error;
    }
    req.headers.authorization = `Bearer ${process.env.ATB_UI_TOKEN ?? ''}`;
    next();
  }
}
