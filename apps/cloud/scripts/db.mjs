#!/usr/bin/env node
// Prisma CLI 包装：把 DATABASE_URL 指到与运行时同一个库文件（CLOUD_DATA_DIR 下的 cloud.db）。
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));

function resolveDataDir() {
  const fromEnv = process.env.CLOUD_DATA_DIR;
  if (fromEnv) return path.resolve(fromEnv);
  if (process.platform === 'win32') {
    const appData = process.env.APPDATA ?? path.join(os.homedir(), 'AppData', 'Roaming');
    return path.join(appData, 'agent-board-cloud');
  }
  return path.join(os.homedir(), '.agent-board-cloud');
}

const dataDir = resolveDataDir();
mkdirSync(dataDir, { recursive: true });
process.env.DATABASE_URL = `file:${path.join(dataDir, 'cloud.db')}`;

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
if (args.length === 0) args.push('generate');

const apiRoot = path.resolve(here, '..');
const schemaPath = path.join(apiRoot, 'prisma', 'schema.prisma');
const needsSchema = !args.includes('--schema');
const child = spawn(bin, needsSchema ? [...args, '--schema', schemaPath] : args, {
  stdio: 'inherit',
  env: process.env,
  cwd: apiRoot,
});
child.on('exit', (code) => process.exit(code ?? 1));
