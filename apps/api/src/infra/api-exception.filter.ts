import {
  ArgumentsHost,
  Catch,
  type ExceptionFilter,
  HttpException,
  Logger,
} from '@nestjs/common';
import type { Request, Response } from 'express';
import { ApiException, type ErrorCode } from '../contract/errors';

const HTTP_TO_CODE: Record<number, ErrorCode> = {
  400: 'VALIDATION_FAILED',
  401: 'UNAUTHORIZED',
  403: 'FORBIDDEN',
  404: 'NOT_FOUND',
  409: 'ILLEGAL_TRANSITION',
  413: 'ARTIFACT_TOO_LARGE',
  422: 'VALIDATION_FAILED',
};

/** 13 章错误响应体形状：{ error: { code, message, ...上下文 } }。所有出口都过这里。 */
@Catch()
export class ApiExceptionFilter implements ExceptionFilter {
  private readonly logger = new Logger('http');

  catch(exception: unknown, host: ArgumentsHost): void {
    if (host.getType<string>() !== 'http') {
      this.logger.error(`非 HTTP 上下文异常: ${(exception as Error)?.stack ?? exception}`);
      return;
    }
    const res = host.switchToHttp().getResponse<Response>();
    const req = host.switchToHttp().getRequest<Request>();

    if (exception instanceof ApiException) {
      this.write(res, exception.status, exception.toBody(), req);
      return;
    }

    if (exception instanceof HttpException) {
      const status = exception.getStatus();
      const code: ErrorCode = HTTP_TO_CODE[status] ?? 'VALIDATION_FAILED';
      const body =
        status === 404
          ? { error: { code: 'NOT_FOUND', message: '资源不存在' } }
          : {
              error: {
                code,
                message:
                  typeof exception.getResponse() === 'string'
                    ? exception.getResponse()
                    : (exception.getResponse() as { message?: string | string[] }).message?.toString() ??
                      exception.message,
              },
            };
      this.write(res, status, body, req);
      return;
    }

    this.logger.error(
      `未预期异常 ${req.method} ${req.originalUrl ?? req.url}: ${(exception as Error)?.stack ?? exception}`,
    );
    this.write(
      res,
      500,
      { error: { code: 'INTERNAL', message: '服务内部错误' } },
      req,
    );
  }

  private write(res: Response, status: number, body: unknown, req: Request): void {
    if (status >= 500) {
      this.logger.error(`${req.method} ${req.url} → ${status}`);
    }
    if (res.headersSent) return;
    res.status(status).json(body);
  }
}
