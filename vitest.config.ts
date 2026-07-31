import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts', 'evals/**/*.test.ts'],
    // Determinism is a product guarantee, so the test run must not depend on
    // the host locale or timezone either.
    env: { TZ: 'UTC', LANG: 'C' },
    testTimeout: 30_000,
  },
})
