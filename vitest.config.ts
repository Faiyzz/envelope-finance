import { defineConfig } from 'vitest/config';
import path from 'path';

export default defineConfig({
  test: {
    globals: true,
    testTimeout: 60_000,
    hookTimeout: 120_000,
    // DB-backed suites run in forks so embedded-postgres processes don't share module state
    pool: 'forks',
    environment: 'node',
    include: ['tests/unit/**/*.test.ts', 'tests/property/**/*.test.ts', 'tests/integration/**/*.test.ts', 'tests/idor/**/*.test.ts'],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'json', 'html'],
      include: ['src/domain/**'],
      exclude: ['node_modules', 'tests', 'src/domain/**/types.ts'],
      // TD-13 §5: domain logic is the heart of the system
      thresholds: { lines: 85, functions: 85, branches: 75, statements: 85 },
    },
  },
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
    },
  },
});
