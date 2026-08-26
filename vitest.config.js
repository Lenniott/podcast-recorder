import { fileURLToPath } from 'url'
import { defineConfig } from 'vitest/config'

const r = (path) => fileURLToPath(new URL(path, import.meta.url))

export default defineConfig({
  resolve: {
    alias: {
      $lib: r('./src/lib'),
      '$env/dynamic/private': r('./tests/mocks/env-dynamic-private.js')
    }
  },
  test: {
    environment: 'node',
    include: ['tests/**/*.test.js'],
    setupFiles: ['tests/setup.js'],
    // Run each test file in isolation so db state doesn't leak
    pool: 'forks',
    reporters: ['verbose'],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'html'],
      include: ['src/**'],
      exclude: ['src/**/*.css', 'src/**/*.svelte', 'src/app.html']
    }
  }
})
