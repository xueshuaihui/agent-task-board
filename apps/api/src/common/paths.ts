import os from 'node:os';
import path from 'node:path';
import { readFileSync } from 'node:fs';

/** 与主进程 `apps/desktop/src-tauri/src/paths.rs` 的 `DEFAULT_PORT` 同值。 */
export const DEFAULT_PORT = 7788;

/**
 * 数据目录：ATB_DATA_DIR 优先（Tauri 主进程注入），否则按平台取默认值（PRD 20.6）。
 * 迁移脚本 scripts/db.mjs 有同一份逻辑，改这里要一起改。
 */
export function dataDir(): string {
  const fromEnv = process.env.ATB_DATA_DIR;
  if (fromEnv) return path.resolve(fromEnv);
  if (process.platform === 'win32') {
    const appData = process.env.APPDATA ?? path.join(os.homedir(), 'AppData', 'Roaming');
    return path.join(appData, 'agent-board');
  }
  return path.join(os.homedir(), '.agent-board');
}

export const paths = {
  dataDir,
  dbFile: () => path.join(dataDir(), 'atb.db'),
  /** 连接参数是认领并发的前提，见 infra/prisma.service.ts 的注释。 */
  datasourceUrl: () =>
    `file:${path.join(dataDir(), 'atb.db')}?journal_mode=WAL&foreign_keys=On&busy_timeout=5000&connection_limit=1`,
  artifactsDir: () => path.join(dataDir(), 'artifacts'),
  backupsDir: () => path.join(dataDir(), 'backups'),
  /**
   * 日志目录独立于数据目录：备份不含它，窗口记忆也不在此（20.9）。
   * `ATB_LOGS_DIR` 只为测试存在——不覆盖的话，跑一次用例就会往真机的 `~/Library/Logs` 里
   * 多挂一个轮转器，和开发中的 sidecar 共用同一份 audit 账本。
   */
  logsDir: () => {
    if (process.env.ATB_LOGS_DIR) return path.resolve(process.env.ATB_LOGS_DIR);
    if (process.platform === 'win32') {
      const appData = process.env.APPDATA ?? path.join(os.homedir(), 'AppData', 'Roaming');
      return path.join(appData, 'AgentTaskBoard', 'logs');
    }
    if (process.platform === 'darwin') {
      return path.join(os.homedir(), 'Library', 'Logs', 'AgentTaskBoard');
    }
    return path.join(
      process.env.XDG_STATE_HOME ?? path.join(os.homedir(), '.local', 'state'),
      'AgentTaskBoard',
      'logs',
    );
  },
};

/**
 * 端口三级决定：`ATB_PORT` → `config.json` 的 `port` → 7788（PRD 20.9 明确它不进 `settings`）。
 * 与主进程的 `paths.rs::resolve_port` 同源，改一边要改另一边。
 *
 * 主进程会把生效端口注入 `ATB_PORT`，所以中间层只在直接跑 sidecar（开发、脚本、
 * 手工重启）时生效——那时它读的正是主进程写下的那份 config.json，验收 15 的
 * 「重启服务后端口不变」才不依赖谁来拉起。
 */
export function port(): number {
  const parsed = Number(process.env.ATB_PORT);
  if (Number.isInteger(parsed) && parsed > 0 && parsed <= 65535) return parsed;
  return configFilePort() ?? DEFAULT_PORT;
}

export function configFile(): string {
  return path.join(dataDir(), 'config.json');
}

function configFilePort(): number | undefined {
  let raw: string;
  try {
    raw = readFileSync(configFile(), 'utf8');
  } catch {
    return undefined;
  }
  try {
    const value = (JSON.parse(raw) as { port?: unknown })?.port;
    return typeof value === 'number' && Number.isInteger(value) && value > 0 && value <= 65535
      ? value
      : undefined;
  } catch {
    // 手改坏的 config.json 不该让 sidecar 起不来：按下一级解析。
    return undefined;
  }
}

export function isDev(): boolean {
  return process.env.NODE_ENV === 'development' || process.env.ATB_DEV === '1';
}
