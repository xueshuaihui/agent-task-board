import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DEFAULT_SETTINGS } from '../../contract/settings';
import { AppLogger } from '../logger';

/** 轮转器是 winston transport 的内部形状，测试只需要读它透传给 file-stream-rotator 的那份 options。 */
interface RotateView {
  options: { maxFiles?: string | number; auditFile?: string; maxSize?: string | number };
}

let dir: string;
let logger: AppLogger;

function rotateOf(instance: AppLogger): RotateView {
  return (instance as unknown as { rotate: RotateView }).rotate;
}

function rotateCount(instance: AppLogger): number {
  const transports = (instance as unknown as { logger: { transports: RotateView[] } }).logger
    .transports;
  return transports.filter((t) => typeof t.options?.auditFile === 'string').length;
}

beforeAll(() => {
  dir = mkdtempSync(path.join(tmpdir(), 'atb-logs-'));
  process.env.ATB_LOGS_DIR = dir;
  logger = new AppLogger();
  logger.setLevel('error');
});

afterAll(async () => {
  // 轮转器建流是异步的：目录先删掉会留下 ENOENT 的未处理拒绝。
  await new Promise((resolve) => setTimeout(resolve, 120));
  delete process.env.ATB_LOGS_DIR;
  rmSync(dir, { force: true, recursive: true });
});

describe('AppLogger 的保留天数（验收 18）', () => {
  it('按 20.9 的默认值建流，且单文件上限是 9.3 固定的 20 MB', () => {
    expect(rotateOf(logger).options.maxFiles).toBe(`${DEFAULT_SETTINGS.log_retention_days}d`);
    expect(rotateOf(logger).options.maxSize).toBe('20m');
  });

  it('applyRetentionDays 换掉 transport，而不是留下两个轮转器抢同一份 audit', () => {
    const auditFile = rotateOf(logger).options.auditFile;
    logger.applyRetentionDays(7);
    expect(rotateOf(logger).options.maxFiles).toBe('7d');
    expect(rotateCount(logger)).toBe(1);
    // 账本名固定：一改天数就换一份空账本的话，清理要从次日重新攒，「设置修改后生效」就成了空话。
    expect(rotateOf(logger).options.auditFile).toBe(auditFile);
    expect(readdirSync(dir)).toContain(path.basename(auditFile as string));
  });

  it('同值与非法值都不动 transport（PATCH 只在变化时调用，这里再兜一层）', () => {
    const before = rotateOf(logger);
    logger.applyRetentionDays(7);
    expect(rotateOf(logger)).toBe(before);
    logger.applyRetentionDays(0);
    expect(rotateOf(logger)).toBe(before);
  });
});
