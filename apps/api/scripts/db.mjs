#!/usr/bin/env node
// Prisma CLI 包装：把 DATABASE_URL 指到与运行时同一个库文件（数据目录下的 jarvis.db）。
// 目的：迁移与 sidecar 读写同一个库，避免「迁移跑在 prisma/dev.db、应用跑在 ~/.jarvis-workbench/jarvis.db」。
// v0.0.4 W1b（需求.md §21.1）：目录/库名与 src/common/paths.ts 同步改齐，改一边要改另一边。
import { spawn, spawnSync } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const apiRoot = path.resolve(here, '..');

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
// DATABASE_URL 必须是合法 file URL：win32 上 path.join 给反斜杠 + 盘符，裸拼
// `file:C:\Users\…` Prisma 引擎解析不了（与 src/common/paths.ts 的 datasourceUrl 同口径）。
process.env.DATABASE_URL = pathToFileURL(path.join(dataDir, 'jarvis.db')).href;

// 定位 prisma CLI 不能找 node_modules/.bin/prisma：Windows 上 npm 生成的 .bin 里
// POSIX shim（无扩展名）与 prisma.cmd 并存，existsSync 会先命中 POSIX shim、
// 再由 spawn 直接执行它——同一个「.bin shim 不可 spawn」的坑。
// 改为用当前 node 二进制跑 prisma 的真实 JS 入口（package.json bin.prisma =
// build/index.js，exports 允许子路径解析），createRequire 从 api 包根起解析、
// 与 npm 自己解析 bin 的走查顺序一致（api-local node_modules → 仓库根）。
const prismaCli = createRequire(path.join(apiRoot, 'package.json')).resolve('prisma/build/index.js');

const args = process.argv.slice(2);
if (args.length === 0) {
  // 缺省 generate：全新环境（npm ci 后）最常用的就是生成 client + 引擎；
  // 迁移/部署等显式传子命令（如 npm run prisma -- migrate deploy）。
  args.push('generate');
}

const schemaPath = path.join(apiRoot, 'prisma', 'schema.prisma');
const needsSchema = !args.includes('--schema');
const child = spawn(process.execPath, needsSchema ? [prismaCli, ...args, '--schema', schemaPath] : [prismaCli, ...args], {
  stdio: 'inherit',
  env: process.env,
  cwd: apiRoot,
});
child.on('exit', (code) => process.exit(code ?? 1));
