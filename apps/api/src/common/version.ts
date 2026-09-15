import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';

/**
 * 单文件 bundle（scripts/bundle-sidecar.mjs）在编译期注入的版本号。
 * bundle 里没有 package.json 可读，走这里直取；tsc/vitest 路径不受影响（undefined 落到文件查找）。
 */
declare const __ATB_BUILD_VERSION__: string | undefined;

/**
 * 版本号只有一个来源：apps/api/package.json，就绪行与「关于」页都读它。
 * 编译产物可能是 `dist/common`（rootDir=src）或 `dist/src/common`（rootDir=仓库根），
 * 两种布局都往上找，不靠猜层数。
 */
function readVersion(): string {
  if (typeof __ATB_BUILD_VERSION__ === 'string' && __ATB_BUILD_VERSION__ && __ATB_BUILD_VERSION__ !== '0.0.0') {
    return __ATB_BUILD_VERSION__;
  }
  const candidates = ['../..', '../../..', '../../../..'].map((up) =>
    path.resolve(__dirname, up, 'package.json'),
  );
  for (const file of candidates) {
    if (!existsSync(file)) continue;
    try {
      const parsed: unknown = JSON.parse(readFileSync(file, 'utf8'));
      const value = (parsed as { dependencies?: Record<string, string> }).dependencies;
      // 只认 api 自己的 package.json（含 @prisma/client），跳过 monorepo 根的那份。
      if (value && '@prisma/client' in value) {
        return String((parsed as { version?: string }).version ?? '0.0.0');
      }
    } catch {
      continue;
    }
  }
  return '0.0.0';
}

export const appVersion = readVersion();
