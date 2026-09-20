#!/usr/bin/env node
// Prisma CLI 包装：把 DATABASE_URL 指到与运行时同一个库文件（数据目录下的 jarvis.db）。
// 目的：迁移与 sidecar 读写同一个库，避免「迁移跑在 prisma/dev.db、应用跑在 ~/.jarvis-workbench/jarvis.db」。
// v0.0.4 W1b（需求.md §21.1）：目录/库名与 src/common/paths.ts 同步改齐，改一边要改另一边。
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
    return path.join(appData, 'jarvis-workbench');
  }
  return path.join(os.homedir(), '.jarvis-workbench');
}

const dataDir = resolveDataDir();
mkdirSync(dataDir, { recursive: true });
process.env.DATABASE_URL = `file:${path.join(dataDir, 'jarvis.db')}`;

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
  // 缺省 generate：全新环境（npm ci 后）最常用的就是生成 client + 引擎；
  // 迁移/部署等显式传子命令（如 npm run prisma -- migrate deploy）。
  args.push('generate');
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
