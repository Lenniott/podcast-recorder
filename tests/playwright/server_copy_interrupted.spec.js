import { test, expect } from '@playwright/test'
import { stubYouTubeApi, createRoom, joinAsGuest, passRecordingCheck } from './helpers.js'

/**
 * Interrupted server-copy upload (ticket 13's second half). Aborts only
 * the chunk-upload requests — never the room WebSocket, never anything
 * else — so this proves the server copy's failure path is fully isolated
 * from local recording, exactly as $lib/server-copy-upload.js's module doc
 * promises ("the local WAV remains the fallback").
 */

function guestPeerRow(page) {
  return page.locator('.peer', { hasText: 'Alex' })
}

test('a blocked upload settles into failed on both browsers without touching local recording', async ({ browser }) => {
  // server-copy-upload.js retries a transient chunk failure with backoff
  // up to RETRY_MAX_ATTEMPTS (5) or RETRY_MAX_ELAPSED_MS (20s), whichever
  // comes first — worst case here is a real ~15s of backoff sleeps before
  // the session gives up and reports `failed`. Give this test enough
  // headroom above the suite's default 60s for that plus room setup.
  test.setTimeout(90_000)

  const host = await browser.newPage()
  await stubYouTubeApi(host)
  const password = 'sc-interrupted'
  const roomUrl = await createRoom(host, { name: `E2E SC Interrupted ${Date.now()}`, password })

  const guest = await browser.newPage()
  await stubYouTubeApi(guest)
  await joinAsGuest(guest, roomUrl, { name: 'Alex', password })

  // Installed before recording starts, per the ticket — every chunk
  // upload for this participant fails outright, but the session endpoint
  // (server-copy/session) and the room's own WebSocket are untouched, so
  // the session is accepted normally and only chunk delivery breaks.
  await guest.route('**/server-copy/chunks*', (route) => route.abort())

  await expect(guest.getByRole('button', { name: 'Start Recording' })).toBeEnabled()
  await guest.getByRole('button', { name: 'Start Recording' }).click()
  await expect(guest.getByRole('button', { name: 'Stop Recording' })).toBeVisible()
  await passRecordingCheck(guest) // clears .check-overlay so Stop Recording is clickable later

  // The pill must settle into `failed` on BOTH browsers while recording is
  // still active (this is deliberately checked before Stop is clicked —
  // "mid-recording" per the ticket) — proving the room's presence
  // broadcast carries the failure to the host exactly like it carries
  // progress in the happy path.
  await expect(guestPeerRow(host).locator('.pill-copy-failed')).toBeVisible({ timeout: 30_000 })
  await expect(guestPeerRow(guest).locator('.pill-copy-failed')).toBeVisible({ timeout: 30_000 })

  // Local recording must be completely unaffected: Stop Recording still
  // works cleanly (captureWriter.stop() and the WAV finalize never touch
  // serverCopyUpload — see +page.svelte's stopRecording()).
  await guest.getByRole('button', { name: 'Stop Recording' }).click()
  // Generous timeout — see server_copy_upload.spec.js's identical note.
  await expect(guest.getByRole('button', { name: 'Start Recording' })).toBeEnabled({ timeout: 20_000 })

  // No download control for a failed copy, on either browser — checked
  // while both are still in the room, before the exit navigation below.
  await expect(host.locator('[data-testid="server-copy-download"]')).toHaveCount(0)
  await expect(guest.locator('[data-testid="server-copy-download"]')).toHaveCount(0)

  // `failed` is deliberately excluded from isIncompleteServerCopyUpload
  // (exit-guard.js: "once a copy has permanently failed there is nothing
  // left to wait for or warn about losing") — and recording is now idle,
  // so leaving must be silent: no active-recording warning, no upload
  // warning, no dialog of any kind. Mirrors recording_status.spec.js's
  // "idle local recording leaves the room without a warning" test.
  let dialogCount = 0
  guest.on('dialog', async (dialog) => {
    dialogCount += 1
    await dialog.dismiss()
  })
  await guest.goto('/')
  expect(dialogCount).toBe(0)

  await guest.close()
  await host.close()
})
