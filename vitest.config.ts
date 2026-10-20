import { defineConfig } from 'vitest/config'

// Only this repository's tests: `work/` holds the pieces' own checkouts, with their own tests.
export default defineConfig({ test: { include: ['test/**/*.test.ts'] } })
