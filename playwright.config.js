import { existsSync } from 'node:fs'
import { defineConfig, devices } from '@playwright/test'

// Specs inherit this process env. Playwright does not load .env on its own.
if (existsSync('.env')) process.loadEnvFile('.env')

const PORT = 5173
// Vite binds to IPv6 loopback on this machine (::1); 127.0.0.1 will not connect.
const BASE_URL = `http://localhost:${PORT}`

export default defineConfig({
  testDir: 'tests/playwright',
  fullyParallel: false,
  forbidOnly: !!process.env.CI,
  // A single retry absorbs the one class of flake that's inherent to
  // testing against `npm run dev`: the *first* navigation to a given route
  // after a fresh server start pays Vite's one-time compile cost for that
  // route's whole module graph, which can occasionally still be settling
  // when a fast scripted fill() lands right after. Every retry after that
  // hits Vite's warm cache. Not CI-only — this repro's locally too.
  retries: 1,
  workers: 1,
  reporter: [['list']],
  timeout: 60_000,
  use: {
    baseURL: BASE_URL,
    trace: 'on-first-retry',
    screenshot: 'only-on-failure',
    permissions: ['clipboard-read', 'clipboard-write', 'microphone'],
    launchOptions: {
      args: ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream']
    }
  },
  // Playwright's bundled Chromium, not the real installed Chrome. The app's
  // own autofill-avoidance fixes (pw-mask CSS, the `noAutofill` action —
  // see src/lib/actions.js) already stop real Chrome's password manager
  // from clobbering the room name/password forms for actual users, but a
  // *separate*, narrower quirk survived: under Playwright's CDP-driven
  // automated clicks specifically (not real, slower human interaction),
  // real Chrome's autofill could still occasionally submit an empty name
  // even though the DOM held the right value right up to the click. That's
  // a CDP-automation artifact of real consumer Chrome, not present in
  // Playwright's own Chromium build — hence testing against that instead.
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
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
