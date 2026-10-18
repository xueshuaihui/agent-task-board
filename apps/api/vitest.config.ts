import { defineConfig } from 'vitest/config';

/** 测试文件放在 `src/**\/__tests__/` 下，tsconfig.build.json 已把它们挡在 dist 之外。 */
export default defineConfig({
  test: {
    environment: 'node',
    include: ['src/**/__tests__/**/*.test.ts'],
    testTimeout: 30_000,
    /**
     * hookTimeout 必须与 testTimeout 对齐。默认 10s 对「建临时库 + 跑 23 条迁移 +
     * 造夹具」的 beforeAll 偏紧：Windows runner 上（Defender 实时扫描 + 70 个测试文件
     * 并行）实测会踩线——v0.0.4-beta.12 的 win-x64 门禁就是 capability /
     * breakdown-draft-replay 两个 beforeAll 卡在 10000ms 挂掉的，同批 68 个文件全绿。
     * 这是机器慢，不是用例写错，所以放宽闸门本身，而不是给单个用例加参。
     */
    hookTimeout: 30_000,
  },
});
