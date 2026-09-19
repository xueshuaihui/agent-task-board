import { Injectable, type PipeTransform } from '@nestjs/common';
import { z, type ZodTypeAny } from 'zod';
import { ApiException } from '../contract/errors';

/** 校验失败一律 `422 VALIDATION_FAILED`，`details[]` 逐项给出路径与原因。 */
@Injectable()
export class ZodPipe<S extends ZodTypeAny> implements PipeTransform {
  constructor(private readonly schema: S) {}

  transform(value: unknown): z.infer<S> {
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

export function zod<S extends ZodTypeAny>(schema: S) {
  return new ZodPipe(schema);
}
