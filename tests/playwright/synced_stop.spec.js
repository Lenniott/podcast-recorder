import { test, expect } from '@playwright/test'
import {
  stubYouTubeApi,
  createRoom,
  joinAsGuest,
  passRecordingCheck
} from './helpers.js'

const STOP_BOTH_CONFIRM = 'Stop recording for both of you? This ends the take.'
const OTHER_SIDE_UNCERTAIN = 'The other side may still be recording.'

/**
 * The server echoes take_marker to every peer, the sender included, so a
 * closed guest page alone never costs the host its end-edge echo. Dropping
 * that one frame is how a spec reaches the host's 2500ms fallback.
 */
async function dropEndEdgeEcho(page) {
  await page.routeWebSocket(/\/ws\?slug=/, (ws) => {
    const server = ws.connectToServer()
    ws.onMessage((raw) => server.send(raw))
    server.onMessage((raw) => {
      try {
        const msg = JSON.parse(typeof raw === 'string' ? raw : String(raw))
        if (msg.type === 'take_marker' && msg.edge === 'end') return
      } catch {}
      ws.send(raw)
    })
  })
}

async function startSyncedTake({ browser, password, beforeHostJoins }) {
  const host = await browser.newPage()
  await stubYouTubeApi(host)
  if (beforeHostJoins) await beforeHostJoins(host)
  const roomUrl = await createRoom(host, { name: `E2E Synced Stop ${Date.now()}`, password })

  const guest = await browser.newPage()
  await stubYouTubeApi(guest)
  await joinAsGuest(guest, roomUrl, { name: 'Alex', password })

  await expect(host.getByRole('button', { name: 'Start Recording' })).toBeEnabled()
  await host.getByRole('button', { name: 'Start Recording' }).click()
  await expect(host.getByRole('button', { name: 'Stop Recording' })).toBeVisible()
  await expect(guest.getByRole('button', { name: 'Stop Recording' })).toBeVisible()

  await passRecordingCheck(host)
  await passRecordingCheck(guest)
  await expect(host.getByTestId('take-marker')).toHaveAttribute('data-take-ready', 'true', { timeout: 10_000 })
  await expect(guest.getByTestId('take-marker')).toHaveAttribute('data-take-ready', 'true', { timeout: 10_000 })
  return { host, guest }
}

test('host Stop asks first; Cancel keeps both recording; confirm stops both after the countdown', async ({ browser }) => {
  const { host, guest } = await startSyncedTake({ browser, password: 'synced-stop' })

  await host.getByRole('button', { name: 'Stop Recording' }).click()
  const confirm = host.getByTestId('stop-confirm')
  await expect(confirm).toBeVisible()
  await expect(confirm).toContainText(STOP_BOTH_CONFIRM)
  await expect(guest.getByTestId('stop-confirm')).toHaveCount(0)

  await host.getByRole('button', { name: 'Keep recording' }).click()
  await expect(confirm).toHaveCount(0)
  await expect(host.getByRole('button', { name: 'Stop Recording' })).toBeVisible()
  await expect(guest.getByRole('button', { name: 'Stop Recording' })).toBeVisible()

  await host.getByRole('button', { name: 'Stop Recording' }).click()
  await host.getByRole('button', { name: 'Stop for both' }).click()
  await expect(host.getByTestId('take-countdown')).toBeVisible()
  await expect(host.getByRole('button', { name: 'Start Recording' })).toBeVisible({ timeout: 20_000 })
  await expect(guest.getByRole('button', { name: 'Start Recording' })).toBeVisible({ timeout: 20_000 })
  await expect(host.getByTestId('other-side-uncertain')).toHaveCount(0)

  await guest.close()
  await host.close()
})

test('guest gone before confirm: the host file still closes and the host is told the other side may be recording', async ({ browser }) => {
  const { host, guest } = await startSyncedTake({
    browser,
    password: 'synced-stop-gone',
    beforeHostJoins: dropEndEdgeEcho
  })

  await guest.close()
  await host.getByRole('button', { name: 'Stop Recording' }).click()
  await expect(host.getByTestId('stop-confirm')).toContainText(STOP_BOTH_CONFIRM)
  await host.getByRole('button', { name: 'Stop for both' }).click()

  await expect(host.getByRole('button', { name: 'Start Recording' })).toBeVisible({ timeout: 20_000 })
  await expect(host.getByTestId('other-side-uncertain')).toHaveText(OTHER_SIDE_UNCERTAIN)

  await host.close()
})
