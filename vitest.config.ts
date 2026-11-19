import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    // Setup installs the built bundle, so build it before any test runs.
    globalSetup: ['test/support/build-bundle.ts'],
    // Some tests start real ssh processes, which are slow on CI runners.
    testTimeout: 30_000,
    coverage: {
      provider: 'v8',
      // Product code only: the fakes under test/support are not measured.
      include: ['src/**/*.ts'],
      reporter: ['text-summary', 'text'],
      thresholds: { statements: 80, branches: 80, functions: 80, lines: 80 },
    },
  },
})
