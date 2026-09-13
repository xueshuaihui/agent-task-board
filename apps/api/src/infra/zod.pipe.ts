import { type ArgumentMetadata, type PipeTransform, Injectable } from '@nestjs/common';
import { z, type ZodTypeAny } from 'zod';
import { ApiException } from '../contract/errors';

/**
 * 校验失败一律 `422 VALIDATION_FAILED`，`details[]` 逐项给出路径与原因（13 章），
 * 前端据此把错误回填到对应控件（原型 8.1 的必填规则）。
 */
@Injectable()
export class ZodPipe<S extends ZodTypeAny> implements PipeTransform {
  constructor(private readonly schema: S) {}

  transform(value: unknown, _meta: ArgumentMetadata): z.infer<S> {
    const parsed = this.schema.safeParse(value);
    if (!parsed.success) {
      throw new ApiException(
        'VALIDATION_FAILED',
        '入参校验失败',
        parsed.error.issues.map((issue) => ({
          path: issue.path.map(String).join('.') || '(root)',
          code: issue.code,
          message: issue.message,
        })),
      );
    }
    return parsed.data as z.infer<S>;
  }
}

/** 装饰器处的用法：`@Body(zod(taskCreateSchema)) body: TaskCreateInput`，推导出的类型即校验后的形状。 */
export function zod<S extends ZodTypeAny>(schema: S) {
  return new ZodPipe(schema);
}
