import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['tests/integration/**/*.test.ts'],
    setupFiles: ['tests/integration/setup.ts'],
    // Real network round trips (Supabase auth + REST).
    testTimeout: 30_000,
    hookTimeout: 30_000,
    environment: 'node',
  },
});
