import { defineConfig } from 'vitest/config';

/**
 * Windows runner（Defender 实时扫描 + 4 核）跑 76 个测试文件时，建临时库 / 全量重放迁移
 * 的实际耗时远高于 mac。v0.0.4-beta.12 把闸门从 10s 提到 30s，beta.13–16 仍在 mcp-tools、
 * creation、cursor-scheduler 等长耗时用例上踩线；state-machine 还出现 ECONNRESET。
 * 根因是并行 worker 争抢 SQLite 文件锁 + Defender 扫描延迟。这里对 Windows 进一步放宽
 * 并改为完全串行执行，避免资源争用导致的级联失败。
 */
const slowPlatform = process.platform === 'win32';

/** 测试文件放在 `src/**\/__tests__/` 下，tsconfig.build.json 已把它们挡在 dist 之外。 */
export default defineConfig({
  test: {
    environment: 'node',
    include: ['src/**/__tests__/**/*.test.ts'],
    testTimeout: slowPlatform ? 180_000 : 30_000,
    hookTimeout: slowPlatform ? 180_000 : 30_000,
    ...(slowPlatform ? { maxWorkers: 1 } : {}),
  },
});
