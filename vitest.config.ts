import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    coverage: {
      provider: 'v8',
      // Product code only: the fakes under test/support are not measured.
      include: ['src/**/*.ts'],
      reporter: ['text-summary', 'text'],
      thresholds: { statements: 80, branches: 80, functions: 80, lines: 80 },
    },
  },
})
