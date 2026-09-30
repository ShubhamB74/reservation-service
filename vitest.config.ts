import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    fileParallelism: false, // tests reset a shared database
    testTimeout: 20_000,
    hookTimeout: 20_000,
  },
});
