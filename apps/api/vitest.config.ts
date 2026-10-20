import { defineConfig } from 'vitest/config';

/**
 * Windows runner（Defender 实时扫描 + 4 核）跑 76 个测试文件时，建临时库 / 全量重放迁移
 * 的实际耗时远高于 mac。v0.0.4-beta.12 把闸门从 10s 提到 30s，beta.13 仍在 mcp-tools 的
 * beforeAll（建库 + 24 条迁移）和 creation 的 0021 迁移演练上踩线；同轮 74/76 文件全绿，
 * 属机器慢而非用例写错。这里只对 Windows 放宽并限制并行度，避免 worker 互相拖慢。
 */
const slowPlatform = process.platform === 'win32';

/** 测试文件放在 `src/**\/__tests__/` 下，tsconfig.build.json 已把它们挡在 dist 之外。 */
export default defineConfig({
  test: {
    environment: 'node',
    include: ['src/**/__tests__/**/*.test.ts'],
    testTimeout: slowPlatform ? 90_000 : 30_000,
    hookTimeout: slowPlatform ? 90_000 : 30_000,
    ...(slowPlatform ? { maxWorkers: 2 } : {}),
  },
});
