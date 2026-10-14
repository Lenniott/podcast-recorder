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
  stopAsHost
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
  await expect(guest.getByRole('button', { name: 'Start Recording' })).toBeEnabled()
  await host.getByRole('button', { name: 'Start Recording' }).click()

  await expect(host.getByRole('button', { name: 'Stop Recording' })).toBeVisible()
  await expect(guest.getByRole('button', { name: 'Stop Recording' })).toBeVisible()

  await expectCheckQuiet(guest, 'host')
  await expect(host.locator('.check-overlay')).toBeVisible()
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
  await expect(guest.getByRole('button', { name: 'Start Recording' })).toBeVisible({ timeout: 20_000 })
  await expect(presenceRow(host, 'Host')).not.toHaveAttribute('data-recording', 'true')
  await expect(presenceRow(host, 'Alex')).not.toHaveAttribute('data-recording', 'true')

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
