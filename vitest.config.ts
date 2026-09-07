import { defineConfig } from 'vitest/config';

export default defineConfig({
  resolve: {
    extensionAlias: {
      '.js': ['.ts', '.js'],
    },
  },
  test: {
    environment: 'node',
    include: ['tests/**/*.test.ts', 'test-fixtures/regressions/**/*.test.ts'],
    exclude: ['tests/fixtures/**'],
    testTimeout: 30_000,
  },
});
