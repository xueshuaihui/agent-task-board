export const ERROR_STATUS = {
  UNAUTHORIZED: 401,
  FORBIDDEN: 403,
  NOT_FOUND: 404,
  ILLEGAL_TRANSITION: 409,
  USERNAME_TAKEN: 409,
  VALIDATION_FAILED: 422,
  INVALID_PARAM: 422,
  INTERNAL: 500,
} as const satisfies Record<string, number>;

export type ErrorCode = keyof typeof ERROR_STATUS;

/** 与 apps/api 同一错误契约：{ error: { code, message, ...上下文 } }。 */
export class ApiException extends Error {
  constructor(
    readonly code: ErrorCode,
    message: string,
    readonly details?: unknown,
    readonly context: Record<string, unknown> = {},
  ) {
    super(message);
  }

  get status(): number {
    return ERROR_STATUS[this.code];
  }

  toBody() {
    return {
      error: {
        code: this.code,
        message: this.message,
        ...this.context,
        ...(this.details === undefined ? {} : { details: this.details }),
      },
    };
  }
}
