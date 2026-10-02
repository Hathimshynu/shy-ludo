import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    globalSetup: ['test/globalSetup.ts'],
    testTimeout: 60_000,
    hookTimeout: 60_000,
    // Test files run in parallel; each one clones its own database.
    fileParallelism: true,
  },
});
