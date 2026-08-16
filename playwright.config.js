import { defineConfig, devices } from '@playwright/test'

const PORT = 5173
// Vite binds to IPv6 loopback on this machine (::1); 127.0.0.1 will not connect.
const BASE_URL = `http://localhost:${PORT}`

export default defineConfig({
  testDir: 'tests/playwright',
  fullyParallel: false,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  workers: 1,
  reporter: [['list']],
  timeout: 60_000,
  use: {
    baseURL: BASE_URL,
    trace: 'on-first-retry',
    screenshot: 'only-on-failure'
  },
  // Use installed Google Chrome — avoids downloading Playwright's Chromium build.
  projects: [{ name: 'chrome', use: { ...devices['Desktop Chrome'], channel: 'chrome' } }],
  webServer: {
    command: 'npm run dev',
    url: BASE_URL,
    reuseExistingServer: !process.env.CI,
    timeout: 120_000,
    // Open the create-room form without a site gate; isolate e2e rooms from local data.
    env: {
      ...process.env,
      SITE_PASSWORD: '',
      DB_PATH: './data/e2e-rooms.db',
      // A serial e2e run creates/joins many rooms in quick succession — far
      // more POSTs per minute than the production rate limiter (20/min) is
      // meant to constrain for a real user. Loosen it for this server only.
      MAX_POSTS_PER_MIN: '200',
      MAX_AUTH_POSTS_PER_MIN: '100'
    }
  }
})
