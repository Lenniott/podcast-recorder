import { test, expect } from '@playwright/test'
import { stubYouTubeApi, createRoom, roomTabsReady, trackLiveSockets, closeLiveSockets } from './helpers.js'

// ROOM_STATE_GRACE_MS is set to 200ms for this e2e server (playwright.config.js)
// specifically so this spec never has to sleep through the real 10s default.
const GRACE_MS = 200

test('room content survives eviction and is restored on rejoin', async ({ browser }) => {
  // An explicit context (not browser.newPage()'s implicit default one) —
  // the default context Playwright creates for browser.newPage() refuses a
  // second newPage() call on it, and we need a second page in the same
  // (cookie-sharing) context after the first one closes.
  const context = await browser.newContext()
  const host = await context.newPage()
  await trackLiveSockets(host)
  await stubYouTubeApi(host)
  const password = 'eviction-test'
  const roomUrl = await createRoom(host, { name: `E2E Eviction ${Date.now()}`, password })

  const notesBox = host.getByRole('textbox', { name: 'Shared notes — visible to everyone in the room…' })
  await notesBox.fill('notes that must survive eviction')
  // Let the debounced tab_text send actually reach the server before we
  // disconnect — the textarea's onInput debounce (see RoomTabs.svelte) is
  // 300ms.
  await host.waitForTimeout(500)

  // Closing just the room's WebSocket (not the whole page) is what actually
  // makes the server see room.size hit 0 promptly — waiting on the Vite
  // proxy to idle-timeout a page-closed socket would be much slower than
  // the 200ms grace period we're trying to test against.
  await closeLiveSockets(host)
  await host.close()

  // Comfortably past the grace period, so the flush-and-evict has actually
  // run (not just been scheduled) before we rejoin.
  await new Promise((resolve) => setTimeout(resolve, GRACE_MS * 5))

  // A fresh page in the same context (same auth/name cookies, no lingering
  // reconnect race from the closed page) — proves this is a real rejoin
  // hydrating from durable storage, not the original socket auto-reconnecting.
  const rejoined = await context.newPage()
  await stubYouTubeApi(rejoined)
  await rejoined.goto(roomUrl)
  await roomTabsReady(rejoined)

  await expect(
    rejoined.getByRole('textbox', { name: 'Shared notes — visible to everyone in the room…' })
  ).toHaveValue('notes that must survive eviction', { timeout: 15_000 })

  await rejoined.close()
  await context.close()
})
