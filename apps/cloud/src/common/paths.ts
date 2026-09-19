import os from 'node:os';
import path from 'node:path';

/** 服务端默认端口 7789（桌面 sidecar 是 7788，两者可在同一台机器并存）。 */
export const DEFAULT_PORT = 7789;

/**
 * 数据目录：CLOUD_DATA_DIR 优先，否则按平台取默认值。
 * scripts/db.mjs 有同一份逻辑，改这里要一起改。
 */
export function dataDir(): string {
  const fromEnv = process.env.CLOUD_DATA_DIR;
  if (fromEnv) return path.resolve(fromEnv);
  if (process.platform === 'win32') {
    const appData = process.env.APPDATA ?? path.join(os.homedir(), 'AppData', 'Roaming');
    return path.join(appData, 'agent-board-cloud');
  }
  return path.join(os.homedir(), '.agent-board-cloud');
}

export const paths = {
  dataDir,
  dbFile: () => path.join(dataDir(), 'cloud.db'),
  /** SQLite 单文件 + WAL；connection_limit=1 收敛写者（与 apps/api 同口径）。 */
  datasourceUrl: () =>
    `file:${path.join(dataDir(), 'cloud.db')}?journal_mode=WAL&foreign_keys=On&busy_timeout=5000&connection_limit=1`,
};

export function port(): number {
  const parsed = Number(process.env.CLOUD_PORT);
  if (Number.isInteger(parsed) && parsed > 0 && parsed <= 65535) return parsed;
  return DEFAULT_PORT;
}

/** CORS 来源：CLOUD_CORS_ORIGINS 未配置或缺省 `*` 时放行任意来源（服务端服务默认公开可浏览）。 */
export function corsOrigins(): string[] | '*' {
  const raw = (process.env.CLOUD_CORS_ORIGINS ?? '').trim();
  if (!raw || raw === '*') return '*';
  return raw
    .split(',')
    .map((value) => value.trim())
    .filter(Boolean);
}

export function jwtSecret(): string {
  return process.env.CLOUD_JWT_SECRET ?? '';
}
