import js from '@eslint/js';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  // 全局忽略：构建产物与覆盖率目录
  { ignores: ['dist/**', 'coverage/**', 'node_modules/**'] },

  // 基础推荐规则（JS + TS）
  js.configs.recommended,
  ...tseslint.configs.recommended,

  // 全项目强制规则：一切随机走 core 的种子 RNG，禁用 Math.random（可复现性契约）
  {
    rules: {
      'no-restricted-properties': [
        'error',
        {
          object: 'Math',
          property: 'random',
          message: '禁止 Math.random：一切随机必须使用 src/core 的种子 RNG，保证同种子全程可复现。',
        },
      ],
    },
  },

  // src/core 纯逻辑层：禁止 import phaser（分层契约）
  {
    files: ['src/core/**/*.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          paths: [
            {
              name: 'phaser',
              message: 'src/core 是纯逻辑层，禁止 import phaser；Phaser 相关代码只允许出现在 src/phaser 视图层。',
            },
          ],
        },
      ],
    },
  },
);
