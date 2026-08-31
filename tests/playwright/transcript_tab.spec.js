import { test, expect } from '@playwright/test'
import {
  stubYouTubeApi,
  createRoom,
  joinAsGuest,
  roomTabsReady,
  trackLiveSockets
} from './helpers.js'

/**
 * Drives a `transcript_line` message straight over the room's live
 * WebSocket, exactly as a real client would once real speech capture
 * exists (ticket 03) — no microphone, no mocking, see helpers.js's
 * trackLiveSockets/window.__prLiveSockets.
 */
async function sendTranscriptLine(page, { speaker, text }) {
  await page.evaluate(
    ({ speaker, text }) => {
      window.__prLiveSockets[0].send(JSON.stringify({ type: 'transcript_line', speaker, text }))
    },
    { speaker, text }
  )
}

test('Transcript tab: permanent, uncloseable, read-only, and shared in order between peers', async ({ browser }) => {
  // Two independent (default) contexts — one per participant, same pattern
  // as guest_notes.spec.js/clap.spec.js — so each holds its own cookies.
  const host = await browser.newPage()
  await trackLiveSockets(host)
  await stubYouTubeApi(host)
  const password = 'transcript-test'
  const roomUrl = await createRoom(host, { name: `E2E Transcript ${Date.now()}`, password })

  // An explicit context (not the implicit one browser.newPage() creates,
  // which refuses a second newPage() call on it — see
  // room_state_eviction.spec.js) since the guest needs a second, later page
  // in the same (cookie-sharing) context once the first one closes.
  const guestContext = await browser.newContext()
  const guest = await guestContext.newPage()
  await stubYouTubeApi(guest)
  await joinAsGuest(guest, roomUrl, { name: 'Guest', password })

  // ── One permanent, uncloseable Transcript tab, alongside the normal
  //    first tab, present from the moment the room is created ──────────
  const transcriptPill = host.getByRole('button', { name: 'Transcript' })
  await expect(transcriptPill).toBeVisible()
  // No close (×) button reachable for it, unlike an ordinary tab.
  await expect(
    host.locator('.tab-pill', { hasText: 'Transcript' }).getByRole('button', { name: /Close/ })
  ).toHaveCount(0)

  // ── Switching to it shows a read-only view: no editable textarea ─────
  await transcriptPill.click()
  await expect(
    host.getByRole('textbox', { name: 'Shared notes — visible to everyone in the room…' })
  ).toBeHidden()
  await expect(host.getByText('No transcript yet')).toBeVisible()

  // ── A driven line is appended, speaker-labeled, and shared with the
  //    other peer in the same order ────────────────────────────────────
  await sendTranscriptLine(host, { speaker: 'Host', text: 'Welcome to the show.' })
  await sendTranscriptLine(host, { speaker: 'Guest', text: 'Thanks for having me.' })

  await expect(host.locator('.transcript-line')).toHaveCount(2)
  await expect(host.locator('.transcript-line').nth(0)).toContainText('Host')
  await expect(host.locator('.transcript-line').nth(0)).toContainText('Welcome to the show.')
  await expect(host.locator('.transcript-line').nth(1)).toContainText('Guest')
  await expect(host.locator('.transcript-line').nth(1)).toContainText('Thanks for having me.')

  // The guest's browser never sent anything — it must see the exact same
  // ordered, labeled lines purely from the server's broadcast.
  await guest.getByRole('button', { name: 'Transcript' }).click()
  await expect(guest.locator('.transcript-line')).toHaveCount(2)
  await expect(guest.locator('.transcript-line').nth(0)).toContainText('Welcome to the show.')
  await expect(guest.locator('.transcript-line').nth(1)).toContainText('Thanks for having me.')

  // ── A late joiner gets the full replay, in order ─────────────────────
  // A fresh page in the guest's own context (same cookies, no lingering
  // reconnect race from the closed page) — same pattern as
  // room_state_eviction.spec.js's rejoin.
  await guest.close() // free a slot — room is capped at 2 connections
  const late = await guestContext.newPage()
  await stubYouTubeApi(late)
  await late.goto(roomUrl)
  await roomTabsReady(late)

  await late.getByRole('button', { name: 'Transcript' }).click()
  await expect(late.locator('.transcript-line')).toHaveCount(2)
  await expect(late.locator('.transcript-line').nth(0)).toContainText('Welcome to the show.')
  await expect(late.locator('.transcript-line').nth(1)).toContainText('Thanks for having me.')

  await late.close()
  await host.close()
  await guestContext.close()
})
