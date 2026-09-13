import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { Injectable, type LoggerService } from '@nestjs/common';
import * as winston from 'winston';
import 'winston-daily-rotate-file';
import { DEFAULT_SETTINGS } from '../contract/settings';
import { isDev, paths } from '../common/paths';

/**
 * stdout 只承载给 Tauri 主进程的行（端口回显，9.4.1 第 4 步），日志一律走文件；
 * 开发模式额外把全量日志、生产模式只把 error 打到 stderr，避免与 stdout 的协议行混淆。
 */
@Injectable()
export class AppLogger implements LoggerService {
  private readonly logger: winston.Logger;
  private rotate: winston.transport;
  private retentionDays: number = DEFAULT_SETTINGS.log_retention_days;

  constructor() {
    mkdirSync(paths.logsDir(), { recursive: true });
    this.rotate = this.createRotateTransport();
    const transports: winston.transport[] = [
      this.rotate,
      new winston.transports.Console({
        stderrLevels: isDev()
          ? ['error', 'warn', 'info', 'http', 'debug', 'silly']
          : ['error'],
      }),
    ];
    this.logger = winston.createLogger({
      level: isDev() ? 'debug' : 'info',
      format: winston.format.combine(
        winston.format.timestamp({ format: 'YYYY-MM-DDTHH:mm:ss.SSSZ' }),
        winston.format.printf(({ timestamp, level, message, context, stack }) => {
          const scope = context ? ` [${context}]` : '';
          return `${timestamp} ${level.toUpperCase()}${scope} ${
            stack ?? message
          }`;
        }),
      ),
      transports,
    });
  }

  setLevel(level: 'debug' | 'info' | 'warn' | 'error'): void {
    this.logger.level = level;
  }

  /**
   * 20.9 把 `log_retention_days` 标成热生效，而 file-stream-rotator 的 `max_logs` 只在建流时读一次，
   * 所以改保留天数只能换掉整个 transport。`auditFile` 固定下来是为了换流后仍认得已有日志——
   * 默认名按 options 哈希，一改天数就换了一份空账本，清理要从第二天重新攒。
   */
  applyRetentionDays(days: number): void {
    if (!Number.isInteger(days) || days < 1 || days === this.retentionDays) return;
    this.retentionDays = days;
    const previous = this.rotate;
    this.rotate = this.createRotateTransport();
    this.logger.remove(previous);
    this.logger.add(this.rotate);
    (previous as unknown as { logStream?: { end?: () => void } }).logStream?.end?.();
  }

  private createRotateTransport(): winston.transport {
    const dirname = paths.logsDir();
    return new winston.transports.DailyRotateFile({
      dirname,
      filename: 'atb-%DATE%.log',
      datePattern: 'YYYY-MM-DD',
      maxSize: '20m',
      maxFiles: `${this.retentionDays}d`,
      auditFile: path.join(dirname, 'atb-log-audit.json'),
    });
  }

  log(message: unknown, context = 'app'): void {
    this.logger.info(this.stringify(message), { context });
  }

  debug(message: unknown, context = 'app'): void {
    this.logger.debug(this.stringify(message), { context });
  }

  verbose(message: unknown, context = 'app'): void {
    this.logger.silly(this.stringify(message), { context });
  }

  warn(message: unknown, context = 'app'): void {
    this.logger.warn(this.stringify(message), { context });
  }

  error(message: unknown, trace?: string, context = 'app'): void {
    this.logger.error(this.stringify(message), { context, stack: trace });
  }

  /** 生命周期回显：给主进程读，独占 stdout。 */
  echo(line: string): void {
    process.stdout.write(`${line}\n`);
  }

  private stringify(message: unknown): string {
    if (typeof message === 'string') return message;
    if (message instanceof Error) return `${message.message}\n${message.stack ?? ''}`;
    try {
      return JSON.stringify(message);
    } catch {
      return String(message);
    }
  }
}

let shared: AppLogger | null = null;

/**
 * 全进程唯一的日志器。`main.ts` 要在 Nest 容器之前拿到它（迁移与 `ATB_READY` 都要写日志），
 * 而 DI 又必须给同一个实例：两个 AppLogger 各自开一个 DailyRotateFile，就会共用同一份 audit
 * 账本互相删对方正在写的文件。
 */
export function sharedAppLogger(): AppLogger {
  shared ??= new AppLogger();
  return shared;
}
