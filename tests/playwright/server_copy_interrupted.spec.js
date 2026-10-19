import { test, expect } from '@playwright/test'
import { stubYouTubeApi, createRoom, joinAsGuest, passRecordingCheck, expandPresenceTable, presenceRow } from './helpers.js'

// Exhausted upload retries stop capture while the local destination finishes.

function guestPeerRow(page) {
  return presenceRow(page, 'Alex')
}

test('exhausted upload retries stop capture and finish the local recording', async ({ browser }) => {
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
  await guest.addInitScript(() => {
    window.__localSaved = false
    window.__recordingIssues = []
    const log = console.error
    console.error = (...args) => {
      if (args[0] === '[recording]') window.__recordingIssues.push(args[1])
      log(...args)
    }
    window.showSaveFilePicker = async () => ({ createWritable: async () => ({
      write: async () => {}, seek: async () => {},
      close: async () => { window.__localSaved = true }
    }) })
  })
  await joinAsGuest(guest, roomUrl, { name: 'Alex', password })
  await expandPresenceTable(host)
  await expandPresenceTable(guest)

  // Installed before recording starts, per the ticket — every chunk
  // upload for this participant fails outright, but the session endpoint
  // (server-copy/session) and the room's own WebSocket are untouched, so
  // the session is accepted normally and only chunk delivery breaks.
  await guest.route('**/server-copy/chunks*', (route) => route.abort())

  await expect(guest.getByRole('button', { name: 'Start Recording' })).toBeEnabled()
  await guest.getByRole('button', { name: 'Start Recording' }).click()
  await expect(guest.getByRole('button', { name: 'Stop Recording' })).toBeVisible()
  await passRecordingCheck(guest) // clears .check-overlay so Stop Recording is clickable later

  // Failure is broadcast to both participants.
  await expect(guestPeerRow(host).locator('[data-testid="server-copy-line"]')).toHaveAttribute(
    'data-copy-state',
    'failed',
    { timeout: 30_000 }
  )
  await expect(guestPeerRow(guest).locator('[data-testid="server-copy-line"]')).toHaveAttribute(
    'data-copy-state',
    'failed',
    { timeout: 30_000 }
  )

  await expect(guest.getByRole('button', { name: 'Start Recording' })).toBeEnabled({ timeout: 20_000 })
  expect(await guest.evaluate(() => window.__localSaved)).toBe(true)
  expect(await guest.evaluate(() => window.__recordingIssues)).toEqual(
    expect.arrayContaining([expect.objectContaining({ code: 'save-failed', destination: 'server' })])
  )

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
