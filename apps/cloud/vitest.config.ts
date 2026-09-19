import { defineConfig } from 'vitest/config';

/** 测试文件放在 `src/**\/__tests__/` 下，tsconfig.build.json 已把它们挡在 dist 之外。 */
export default defineConfig({
  test: {
    environment: 'node',
    include: ['src/**/__tests__/**/*.test.ts'],
    testTimeout: 30_000,
  },
});
