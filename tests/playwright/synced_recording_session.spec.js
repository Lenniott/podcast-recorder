import { test, expect } from '@playwright/test'
import {
  stubYouTubeApi,
  createRoom,
  joinAsGuest,
  trackLiveSockets,
  closeLiveSockets,
  passRecordingCheck,
  expectCheckQuiet,
  expandPresenceTable,
  presenceRow,
  stopAsHost,
  startViaGuestRequest,
  localCopyFiles
} from './helpers.js'

test('host Start starts guest recording without a guest click; host Stop stops both', async ({ browser }) => {
  const host = await browser.newPage()
  await stubYouTubeApi(host)
  const password = 'sync-session'
  const roomUrl = await createRoom(host, { name: `E2E Sync Session ${Date.now()}`, password })

  const guest = await browser.newPage()
  await stubYouTubeApi(guest)
  await joinAsGuest(guest, roomUrl, { name: 'Alex', password })

  await expect(host.getByRole('button', { name: 'Start Recording' })).toBeEnabled()
  await expect(guest.getByRole('button', { name: 'Request to start recording' })).toBeEnabled()
  await host.getByRole('button', { name: 'Start Recording' }).click()

  await expect(host.getByRole('button', { name: 'Stop Recording' })).toBeVisible()
  await expect(guest.getByRole('button', { name: 'Request to stop recording' })).toBeVisible()

  await expectCheckQuiet(guest, 'host')
  await expect(host.getByRole('dialog', { name: 'Test your microphone?' })).toBeVisible()
  await passRecordingCheck(host)
  await expectCheckQuiet(host, 'guest')
  await passRecordingCheck(guest)
  await expect(host.getByTestId('check-turn')).toHaveAttribute('data-both-turns-passed', 'true')
  await expect(guest.getByTestId('check-turn')).toHaveAttribute('data-both-turns-passed', 'true')

  await expandPresenceTable(host)
  await expect(presenceRow(host, 'Host')).toHaveAttribute('data-recording', 'true')
  await expect(presenceRow(host, 'Alex')).toHaveAttribute('data-recording', 'true')
  await stopAsHost(host)

  await expect(host.getByRole('button', { name: 'Start Recording' })).toBeVisible({ timeout: 20_000 })
  await expect(guest.getByRole('button', { name: 'Request to start recording' })).toBeVisible({ timeout: 20_000 })
  await expect(presenceRow(host, 'Host')).not.toHaveAttribute('data-recording', 'true')
  await expect(presenceRow(host, 'Alex')).not.toHaveAttribute('data-recording', 'true')

  await guest.close()
  await host.close()
})

test('guest Start with host present asks the host; accept starts both', async ({ browser }) => {
  const host = await browser.newPage()
  await stubYouTubeApi(host)
  const password = 'sync-guest-ask'
  const roomUrl = await createRoom(host, { name: `E2E Guest Ask ${Date.now()}`, password })

  const guest = await browser.newPage()
  await stubYouTubeApi(guest)
  await joinAsGuest(guest, roomUrl, { name: 'Alex', password })

  await expect(guest.getByRole('button', { name: 'Request to start recording' })).toBeEnabled()
  await startViaGuestRequest(host, guest)
  await expect(host.getByRole('button', { name: 'Stop Recording' })).toBeEnabled()
  await expect(guest.getByRole('button', { name: 'Request to stop recording' })).toBeEnabled()
  // Approval starts the room: each browser writes audio before either check
  // has been passed. Checking is not a separate guest-only recording.
  for (const participant of [host, guest]) {
    await expect.poll(() => localCopyFiles(participant)).toHaveLength(1)
    await expect.poll(() => participant.evaluate(async () => {
      const root = await navigator.storage.getDirectory()
      const base = await root.getDirectoryHandle('local-copy')
      const room = await base.getDirectoryHandle(location.pathname.split('/').pop())
      let bytes = 0
      for await (const [, handle] of room.entries()) {
        if (handle.kind === 'file') bytes += (await handle.getFile()).size
      }
      return bytes
    })).toBeGreaterThan(44)
  }
  await expectCheckQuiet(guest, 'host')
  await expect(host.getByRole('dialog', { name: 'Test your microphone?' })).toBeVisible()
  await passRecordingCheck(host)
  await passRecordingCheck(guest)
  await expect(host.getByTestId('check-turn')).toHaveAttribute('data-both-turns-passed', 'true')
  await expect(guest.getByTestId('check-turn')).toHaveAttribute('data-both-turns-passed', 'true')

  await guest.close()
  await host.close()
})

test('host declines a guest start request: guest button returns and a toast explains why', async ({ browser }) => {
  const host = await browser.newPage()
  await stubYouTubeApi(host)
  const password = 'sync-guest-no'
  const roomUrl = await createRoom(host, { name: `E2E Guest No ${Date.now()}`, password })

  const guest = await browser.newPage()
  await stubYouTubeApi(guest)
  await joinAsGuest(guest, roomUrl, { name: 'Alex', password })

  await guest.getByRole('button', { name: 'Request to start recording' }).click()
  await expect(guest.getByRole('button', { name: 'Waiting for host…' })).toBeDisabled()
  await expect(host.getByTestId('guest-record-request')).toBeVisible()
  await host.getByRole('button', { name: 'No', exact: true }).click()

  await expect(host.getByTestId('guest-record-request')).toHaveCount(0)
  await expect(guest.getByRole('button', { name: 'Request to start recording' })).toBeEnabled()
  await expect(guest.getByTestId('host-declined-toast')).toHaveText("The host isn't ready to start yet.")
  await expect(host.getByRole('button', { name: 'Start Recording' })).toBeVisible()

  await guest.close()
  await host.close()
})

test('host left the room: guest Start/Stop records solo without asking anyone', async ({ browser }) => {
  const host = await browser.newPage()
  await stubYouTubeApi(host)
  const password = 'sync-host-gone'
  const roomUrl = await createRoom(host, { name: `E2E Host Gone ${Date.now()}`, password })

  const guest = await browser.newPage()
  await stubYouTubeApi(guest)
  await joinAsGuest(guest, roomUrl, { name: 'Alex', password })

  await host.close()
  // Presence drops the host; guest stays connected and must not wait on anyone.
  await expect(guest.getByText('Waiting for guest…').first()).toBeVisible({ timeout: 15_000 })

  await expect(guest.getByRole('button', { name: 'Start Recording' })).toBeEnabled()
  await guest.getByRole('button', { name: 'Start Recording' }).click()
  await expect(guest.getByRole('button', { name: 'Request to start recording' })).toHaveCount(0)
  await expect(guest.getByRole('button', { name: 'Stop Recording' })).toBeVisible()
  await expect(guest.getByRole('dialog', { name: 'Test your microphone?' })).toBeVisible()

  await passRecordingCheck(guest)
  await guest.getByRole('button', { name: 'Stop Recording' }).click()
  await expect(guest.getByRole('button', { name: 'Start Recording' })).toBeVisible({ timeout: 20_000 })

  await guest.close()
})

test('a pending guest start takes effect automatically when the host leaves', async ({ browser }) => {
  const host = await browser.newPage()
  await stubYouTubeApi(host)
  const password = 'pending-host-leaves'
  const roomUrl = await createRoom(host, { name: `E2E Pending Request ${Date.now()}`, password })
  const guest = await browser.newPage()
  await stubYouTubeApi(guest)
  await joinAsGuest(guest, roomUrl, { name: 'Alex', password })
  await guest.getByRole('button', { name: 'Request to start recording' }).click()
  await expect(guest.getByRole('button', { name: 'Waiting for host…' })).toBeDisabled()
  await expect(guest.getByTestId('cancel-host-request')).toHaveCount(0)
  await expect(host.getByTestId('guest-record-request')).toBeVisible()
  await host.close()
  await expect(guest.getByRole('button', { name: 'Stop Recording' })).toBeEnabled()
  await expect(guest.getByRole('dialog', { name: 'Test your microphone?' })).toBeVisible()
  await passRecordingCheck(guest)
  await guest.getByRole('button', { name: 'Stop Recording' }).click()
  await expect(guest.getByRole('button', { name: 'Start Recording' })).toBeVisible()
  await guest.close()
})

test('guest solo-passed then host returns: the room starts the host and Check Turn completes', async ({ browser }) => {
  const host = await browser.newPage()
  await trackLiveSockets(host)
  await stubYouTubeApi(host)
  const password = 'sync-guest-first'
  const roomUrl = await createRoom(host, { name: `E2E Guest First ${Date.now()}`, password })

  const guest = await browser.newPage()
  await stubYouTubeApi(guest)
  await joinAsGuest(guest, roomUrl, { name: 'Alex', password })

  // Drop the host's socket so presence loses them; guest can Start solo.
  await host.context().setOffline(true)
  await closeLiveSockets(host)
  await expect(guest.getByText('Waiting for guest…').first()).toBeVisible({ timeout: 15_000 })

  await guest.getByRole('button', { name: 'Start Recording' }).click()
  await expect(guest.getByRole('button', { name: 'Stop Recording' })).toBeVisible()
  await guest.getByRole('button', { name: 'Skip microphone check' }).click()
  await expect(guest.getByRole('dialog', { name: 'Test your microphone?' })).toHaveCount(0)

  await host.context().setOffline(false)
  await expect(host.getByRole('button', { name: 'Stop Recording' })).toBeVisible({ timeout: 20_000 })

  // Solo Skip keeps the returning guest in the room through the new paired round.
  await expect(guest.getByRole('button', { name: 'Show check' })).toBeVisible()
  await expect(guest.getByRole('dialog')).toHaveCount(0)
  await passRecordingCheck(host)
  await guest.getByRole('button', { name: 'Show check' }).click()
  await expect(guest.getByRole('dialog', { name: 'Test your microphone?' })).toBeVisible()
  await passRecordingCheck(guest)
  await expect(host.getByTestId('check-quiet')).toHaveCount(0)
  await expect(guest.getByTestId('check-quiet')).toHaveCount(0)
  await expect(host.getByTestId('check-turn')).toHaveAttribute('data-both-turns-passed', 'true')
  await expect(guest.getByTestId('check-turn')).toHaveAttribute('data-both-turns-passed', 'true')
  await expect(guest.getByRole('dialog', { name: 'Test your microphone?' })).toHaveCount(0)

  await expect(host.getByTestId('take-countdown')).toBeVisible()
  await expect(guest.getByTestId('take-countdown')).toBeVisible()
  await expect(host.getByTestId('take-marker')).toHaveAttribute('data-take-ready', 'true', { timeout: 15000 })
  await expect(guest.getByTestId('take-marker')).toHaveAttribute('data-take-ready', 'true')

  await guest.close()
  await host.close()
})

test('guest WebSocket down: guest own Start/Stop still works solo', async ({ browser }) => {
  const host = await browser.newPage()
  await stubYouTubeApi(host)
  const password = 'sync-offline'
  const roomUrl = await createRoom(host, { name: `E2E Sync Offline ${Date.now()}`, password })

  const guest = await browser.newPage()
  await trackLiveSockets(guest)
  await stubYouTubeApi(guest)
  await joinAsGuest(guest, roomUrl, { name: 'Alex', password })

  await guest.context().setOffline(true)
  await closeLiveSockets(guest)
  await expect(guest.getByText('Offline').first()).toBeVisible({ timeout: 15_000 })

  await expect(guest.getByRole('button', { name: 'Start Recording' })).toBeEnabled()
  await guest.getByRole('button', { name: 'Start Recording' }).click()
  await expect(guest.getByRole('button', { name: 'Stop Recording' })).toBeVisible()
  await expect(host.getByRole('button', { name: 'Start Recording' })).toBeVisible()

  await passRecordingCheck(guest)
  await guest.getByRole('button', { name: 'Stop Recording' }).click()
  await expect(guest.getByRole('button', { name: 'Start Recording' })).toBeVisible({ timeout: 20_000 })
  await expect(host.getByRole('button', { name: 'Start Recording' })).toBeVisible()

  await guest.close()
  await host.close()
})
