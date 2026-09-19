import type { CorsOptions } from '@nestjs/common/interfaces/external/cors-options.interface';
import { allowedOrigins } from './origins';

/**
 * 9.4.3 的 CORS 契约：精确匹配白名单、不回显任意来源、不接受 `Origin: null`。
 *
 * 唯一一份配置，`main.ts` 与测试底座都从这里取——两处各写一份时，方法表漏一项
 * （PUT：`/prefs/:key` 与 `/skills/sources`）只有真浏览器会撞上面，测试全绿。
 */
export function corsOptions(): CorsOptions {
  const allow = new Set(allowedOrigins());
  return {
    origin(origin, callback) {
      if (!origin) return callback(null, true);
      return callback(null, allow.has(origin));
    },
    methods: ['GET', 'PUT', 'POST', 'PATCH', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Authorization', 'Content-Type', 'Accept'],
    maxAge: 600,
    credentials: false,
  };
}
