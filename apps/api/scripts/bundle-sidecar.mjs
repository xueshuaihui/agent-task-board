#!/usr/bin/env node
/**
 * 装配桌面打包的 sidecar 资源（tauri build 的前置步骤）。
 *
 * 背景（2026-09-15 真机验收发现的缺陷）：`.app` 原本只打包 `dist/main.js` 单文件，
 * 而 `nest build` 产物运行时既需要 node_modules（@nestjs/core…），也需要 dist 下
 * 其余编译文件（./app.module…），从 Finder 双击启动必然报
 * `Cannot find module '@nestjs/core'`。
 *
 * 方案：webpack（ts-loader，保留 emitDecoratorMetadata —— esbuild 不支持该特性，
 * Nest 依赖注入会拿到 undefined）把 API 打成**单文件 CJS bundle**，仅 `@prisma/client`
 * 外置（Prisma 运行时要按自身目录定位 query engine 原生库，不能被 bundle）；
 * 再把「最小 Prisma 运行时」+ 迁移目录 + node 二进制一起装配进
 * `apps/desktop/src-tauri/resources/sidecar/`，tauri.conf.json 按目录整体打进 .app。
 *
 * 产物布局（全部被 .gitignore 覆盖，不入库）：
 *   resources/sidecar/
 *   ├── main.js                    # 单文件 bundle（entry，sidecar.rs 第 2 档找它）
 *   ├── node                       # node 运行时（ATB_NODE_BIN 或当前执行的 node）
 *   ├── prisma/migrations/         # 迁移 SQL（bootstrap.ts 候选一）
 *   └── node_modules/
 *       ├── @prisma/client/        # 仅 package.json + 入口 + runtime/library.js
 *       └── .prisma/client/        # 生成客户端 + schema + query engine 原生库
 *
 * 用法：`npm run build:sidecar -w @atb/api`
 *   ATB_NODE_BIN 可显式指定 node 源（如跨架构打包），缺省用当前执行的 node。
 */
import { copyFileSync, existsSync, mkdirSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const apiRoot = path.resolve(scriptDir, '..');
const repoRoot = path.resolve(apiRoot, '../..');
const resourcesDir = path.resolve(apiRoot, '../desktop/src-tauri/resources/sidecar');
const require = createRequire(import.meta.url);

const log = (...parts) => console.log('[bundle-sidecar]', ...parts);
const die = (message) => {
  console.error('[bundle-sidecar]', message);
  process.exit(1);
};

const copyTo = (source, targetDir) => {
  if (!existsSync(source)) die(`缺少源文件：${source}（先 npm install / prisma generate）`);
  mkdirSync(path.dirname(targetDir), { recursive: true });
  copyFileSync(source, targetDir);
  return statSync(source).size;
};

let totalBytes = 0;

// ---------- 1. webpack 单文件 bundle ----------
const webpack = require('webpack');
const pkg = require(path.join(apiRoot, 'package.json'));
const compiler = webpack({
  mode: 'production',
  target: 'node',
  devtool: false,
  entry: path.join(apiRoot, 'src/main.ts'),
  output: {
    path: resourcesDir,
    filename: 'main.js',
    // 保留真实 __dirname：迁移目录与 Prisma 引擎都按它定位（不能 mock）。
    // bundle 里没有 package.json，版本号编译期注入（见 version.ts）。
  },
  node: { __dirname: false, __filename: false },
  module: {
    rules: [
      {
        test: /\.ts$/,
        exclude: /node_modules/,
        loader: 'ts-loader',
        options: {
          configFile: path.join(apiRoot, 'tsconfig.build.json'),
          transpileOnly: false, // 不跳类型检查：装饰器元数据依赖完整类型信息
        },
      },
    ],
  },
  resolve: {
    extensions: ['.ts', '.js'],
  },
  externals: {
    // Prisma 必须外置：引擎加载按 client 自身 __dirname 定位原生库，bundle 会破坏路径。
    '@prisma/client': 'commonjs @prisma/client',
  },
  plugins: [
    new webpack.DefinePlugin({
      __ATB_BUILD_VERSION__: JSON.stringify(pkg.version ?? '0.0.0'),
    }),
    // Nest 的可选 peer 依赖（包内懒加载 require，含子路径如 socket-module），本项目全部未使用。
    // 统一替换成哑桩（scripts/stub-optional.js）：模块顶层解构安全（属性 undefined），
    // 误用相关功能会拿到 undefined 报错，届时应安装真包并从此正则移除。
    new webpack.NormalModuleReplacementPlugin(
      /^(class-transformer|class-validator|cache-manager|@nestjs\/(microservices|websockets|platform-socket\.io)(\/[\w.-]+)?)$/,
      path.join(scriptDir, 'stub-optional.js'),
    ),
  ],
  optimization: { minimize: false },
  performance: { hints: false },
  stats: 'errors-warnings',
}, (error, stats) => {
  if (error) die(`webpack 执行失败：${error.message}`);
  if (stats.hasErrors()) {
    die(`bundle 失败：\n${stats.toString({ colors: false, errors: true, errorDetails: true })}`);
  }
  if (stats.hasWarnings()) log(`webpack 警告（懒加载可选依赖，未使用即无害）：\n${stats.toString({ colors: false, warnings: true, modules: false, assets: false })}`);
  log('bundle 完成');
});
// close 是异步收尾（落盘产物在其中）：必须等它结束再 stat，否则 CI 慢盘上
// main.js 尚未写完就报 ENOENT——本地机器快，恰好总能先写完，掩盖了这个竞态。
await new Promise((resolve, reject) => {
  compiler.close((closeError) => (closeError ? reject(closeError) : resolve()));
});
totalBytes += statSync(path.join(resourcesDir, 'main.js')).size;

// ---------- 2. 最小 Prisma 运行时（约 21M，比整包 97M 小一个量级） ----------
const rootModules = path.join(repoRoot, 'node_modules');
const prismaClientDir = path.join(resourcesDir, 'node_modules', '@prisma', 'client');
const prismaGenDir = path.join(resourcesDir, 'node_modules', '.prisma', 'client');

for (const file of ['package.json', 'index.js', 'default.js']) {
  totalBytes += copyTo(path.join(rootModules, '@prisma/client', file), path.join(prismaClientDir, file));
}
// 生成客户端只引用 library 变体（.prisma/client/index.js 实测），其余 73M runtime 全部不装。
totalBytes += copyTo(path.join(rootModules, '@prisma/client/runtime/library.js'), path.join(prismaClientDir, 'runtime/library.js'));

for (const file of ['package.json', 'index.js', 'default.js', 'client.js', 'schema.prisma']) {
  totalBytes += copyTo(path.join(rootModules, '.prisma/client', file), path.join(prismaGenDir, file));
}
// query engine 原生库：按前缀全收（darwin 平台 1 个，arm64 机器上生成的是 -arm64 变体）。
const engineFiles = readdirSync(path.join(rootModules, '.prisma/client')).filter((name) =>
  /^libquery_engine-.+\.node$/.test(name),
);
if (engineFiles.length === 0) die(`未找到 query engine（${rootModules}/.prisma/client），先 npm run prisma`);
for (const file of engineFiles) {
  totalBytes += copyTo(path.join(rootModules, '.prisma/client', file), path.join(prismaGenDir, file));
}

// ---------- 3. 迁移目录（bootstrap.ts 候选一：__dirname/prisma/migrations） ----------
const migrationsSource = path.join(apiRoot, 'prisma', 'migrations');
if (!existsSync(migrationsSource)) die(`缺少迁移目录：${migrationsSource}`);
mkdirSync(path.join(resourcesDir, 'prisma'), { recursive: true });
for (const entry of readdirSync(migrationsSource, { withFileTypes: true })) {
  if (!entry.isDirectory() || !/^\d+_/.test(entry.name)) continue;
  const sql = path.join(migrationsSource, entry.name, 'migration.sql');
  if (!existsSync(sql)) die(`${entry.name} 缺少 migration.sql`);
  const target = path.join(resourcesDir, 'prisma', 'migrations', entry.name);
  mkdirSync(target, { recursive: true });
  copyFileSync(sql, path.join(target, 'migration.sql'));
  totalBytes += statSync(sql).size;
}
log(`迁移目录已装配（${readdirSync(path.join(resourcesDir, 'prisma', 'migrations')).length} 项）`);

// ---------- 4. node 运行时 ----------
const nodeSource = process.env.ATB_NODE_BIN?.trim() || process.execPath;
if (!existsSync(nodeSource)) die(`node 源不存在：${nodeSource}（用 ATB_NODE_BIN 显式指定）`);
copyFileSync(nodeSource, path.join(resourcesDir, 'node'));
totalBytes += statSync(nodeSource).size;

const mb = (bytes) => `${(bytes / 1024 / 1024).toFixed(1)}M`;
log(`装配完成 → ${resourcesDir}`);
log(`  main.js + prisma 最小运行时 + 迁移 + node 共 ${mb(totalBytes)}（engine：${engineFiles.join(', ')}）`);
