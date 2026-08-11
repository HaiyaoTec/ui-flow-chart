import { resolve } from 'node:path'
import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    // E2E 归 Playwright 跑，别让 vitest 去收集
    include: ['tests/unit/**/*.test.ts', 'tests/integration/**/*.test.ts'],
    environment: 'node',
  },
  resolve: {
    alias: { '@shared': resolve('src/shared') },
  },
})
