import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    environment: 'node',
    include: ['tests/**/*.test.js'],
    setupFiles: ['tests/setup.js'],
    // Run each test file in isolation so db state doesn't leak
    pool: 'forks',
    reporters: ['verbose']
  }
})
