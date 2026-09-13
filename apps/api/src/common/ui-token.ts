import { randomBytes, timingSafeEqual } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { dataDir, isDev } from './paths';

/**
 * UI 会话 Token：生产路径只由 Tauri 主进程生成并经环境变量注入（9.4.1 第 2、3 步），
 * 不落盘、不进查询参数。开发模式下没有主进程，退化为写一个 0600 的文件，
 * 由 vite.config 读走并注入前端——它等价于「本机当前登录用户可读」，不对外暴露。
 */
const DEV_TOKEN_FILE = 'dev-ui-token';

function devTokenPath(): string {
  return path.join(dataDir(), DEV_TOKEN_FILE);
}

export function resolveUiToken(): string {
  const fromEnv = process.env.ATB_UI_TOKEN;
  if (fromEnv && fromEnv.length >= 32) return fromEnv;
  if (!isDev()) {
    throw new Error(
      'ATB_UI_TOKEN 未注入：sidecar 必须由 Tauri 主进程拉起（PRD 9.4.1 第 3 步）。本地调试请设 ATB_DEV=1。',
    );
  }
  const file = devTokenPath();
  if (existsSync(file)) {
    const stored = readFileSync(file, 'utf8').trim();
    if (stored.length >= 32) return stored;
  }
  mkdirSync(path.dirname(file), { recursive: true });
  const generated = randomBytes(32).toString('hex');
  writeFileSync(file, generated, { mode: 0o600 });
  chmodSync(file, 0o600);
  return generated;
}

export function constantTimeEqual(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  if (left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}
