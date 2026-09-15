import { defineConfig } from 'vitest/config';

// vitest 仅测 core（纯逻辑层）：只收集 src/core 下的 *.test.ts / *.spec.ts
export default defineConfig({
  test: {
    environment: 'node',
    include: ['src/core/**/*.test.ts', 'src/core/**/*.spec.ts'],
    passWithNoTests: true,
  },
});
