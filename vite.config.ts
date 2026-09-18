import { defineConfig } from 'vitest/config';

// vitest 测试：收集 src/core 与 src/game 下的 *.test.ts / *.spec.ts
export default defineConfig({
  test: {
    environment: 'node',
    include: [
      'src/core/**/*.test.ts',
      'src/core/**/*.spec.ts',
      'src/game/**/*.test.ts',
      'src/game/**/*.spec.ts',
    ],
    passWithNoTests: true,
  },
});
