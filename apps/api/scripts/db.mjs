#!/usr/bin/env node
// Prisma CLI 包装：把 DATABASE_URL 指到与运行时同一个库文件（数据目录下的 atb.db）。
// 目的：迁移与 sidecar 读写同一个库，避免「迁移跑在 prisma/dev.db、应用跑在 ~/.agent-board/atb.db」。
import { spawn, spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdirSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));

function resolveDataDir() {
  const fromEnv = process.env.ATB_DATA_DIR;
  if (fromEnv) return path.resolve(fromEnv);
  if (process.platform === 'win32') {
    const appData = process.env.APPDATA ?? path.join(os.homedir(), 'AppData', 'Roaming');
    return path.join(appData, 'agent-board');
  }
  return path.join(os.homedir(), '.agent-board');
}

const dataDir = resolveDataDir();
mkdirSync(dataDir, { recursive: true });
process.env.DATABASE_URL = `file:${path.join(dataDir, 'atb.db')}`;

const candidates = [
  path.resolve(here, '..', '..', '..', 'node_modules', '.bin', 'prisma'),
  path.resolve(here, '..', 'node_modules', '.bin', 'prisma'),
];
const bin = candidates.find((p) => existsSync(p));
if (!bin) {
  console.error(`找不到 prisma CLI，尝试过：\n${candidates.join('\n')}`);
  process.exit(1);
}

const args = process.argv.slice(2);
if (args.length === 0) {
  console.error('用法：node scripts/db.mjs <prisma 子命令> [参数…]  例如 migrate deploy');
  process.exit(1);
}

const apiRoot = path.resolve(here, '..');
const schemaPath = path.join(apiRoot, 'prisma', 'schema.prisma');
const needsSchema = !args.includes('--schema');
const child = spawn(bin, needsSchema ? [...args, '--schema', schemaPath] : args, {
  stdio: 'inherit',
  env: process.env,
  cwd: apiRoot,
});
child.on('exit', (code) => process.exit(code ?? 1));
