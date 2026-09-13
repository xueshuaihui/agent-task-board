import { sharedAppLogger } from '../infra/logger';
import type { AppLogger } from '../infra/logger';

/**
 * 已经记过的 (表.字段, 原值)。
 *
 * 20.2 末段要求「读到表外值时写一条 error 日志」，但看板与列表每次刷新都会把同一行重读一遍，
 * 照字面每条都记就会把日志刷成噪音。这里按最简做法收敛：一个进程级 Set，
 * 同一 (字段, 值) 最多记一次——重启后再见到仍然会记，不牺牲发现能力。
 */
const logged = new Set<string>();

/**
 * 读到 20.2 枚举表之外的值（历史库、手改数据）：不崩溃、原样透传、界面渲染「未知（原值）」，
 * 服务端这边补一条 error 日志（验收 43）。
 *
 * 消息只由「表名 + 字段名 + 库里那个原值」三段拼成：这三项本就是业务数据，
 * 不带请求头、不带 Token、不带整行记录（15 章：日志与错误体都不得泄漏凭证）。
 * `logger` 默认取全进程唯一的日志器，测试可传替身。
 */
export function reportUnknownEnumValue(
  table: string,
  field: string,
  value: string,
  logger: Pick<AppLogger, 'error'> = sharedAppLogger(),
): void {
  const key = `${table}.${field}=${value}`;
  if (logged.has(key)) return;
  logged.add(key);
  logger.error(
    `读到 20.2 枚举表之外的值：${table}.${field} = "${value}"（已原样透传，界面按「未知（原值）」渲染）`,
    undefined,
    'enum-read',
  );
}
