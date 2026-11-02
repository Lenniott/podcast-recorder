import { test, expect } from '@playwright/test'
import {
  stubYouTubeApi,
  createRoom,
  joinAsGuest,
  passRecordingCheck,
  expectCheckQuiet,
  trackLiveSockets,
  closeLiveSockets,
  localCopyFiles
} from './helpers.js'

test('synced start runs host check then guest check with stay-quiet on the other screen', async ({ browser }) => {
  const host = await browser.newPage()
  await stubYouTubeApi(host)
  const password = 'check-turn'
  const roomUrl = await createRoom(host, { name: `E2E Check Turn ${Date.now()}`, password })

  const guest = await browser.newPage()
  await stubYouTubeApi(guest)
  await joinAsGuest(guest, roomUrl, { name: 'Alex', password })

  await host.getByRole('button', { name: 'Start Recording' }).click()
  await expect(host.getByRole('button', { name: 'Stop Recording' })).toBeVisible()
  await expect(guest.getByRole('button', { name: 'Request to stop recording' })).toBeVisible()

  await expect(host.getByRole('dialog', { name: 'Test your microphone?' })).toBeVisible()
  await expectCheckQuiet(guest, 'host')
  await expect(host.getByTestId('check-turn')).toHaveAttribute('data-check-turn', 'host')
  await expect(guest.getByTestId('check-turn')).toHaveAttribute('data-check-turn', 'host')
  await expect(host.getByTestId('check-turn')).toHaveAttribute('data-both-turns-passed', 'false')

  await passRecordingCheck(host)
  await expect(guest.getByRole('dialog', { name: 'Test your microphone?' })).toBeVisible()
  await expectCheckQuiet(host, 'guest')
  await expect(host.getByTestId('check-turn')).toHaveAttribute('data-check-turn', 'guest')

  await passRecordingCheck(guest)
  await expect(host.getByTestId('check-quiet')).toHaveCount(0)
  await expect(guest.getByTestId('check-quiet')).toHaveCount(0)
  await expect(host.getByTestId('check-turn')).toHaveAttribute('data-both-turns-passed', 'true')
  await expect(guest.getByTestId('check-turn')).toHaveAttribute('data-both-turns-passed', 'true')
  await expect(host.getByTestId('check-turn')).toHaveAttribute('data-check-turn', 'passed')

  await expect(host.getByTestId('take-marker')).toHaveAttribute('data-take-ready', 'false')
  await expect(guest.getByTestId('take-marker')).toHaveAttribute('data-take-ready', 'false')
  await expect(host.getByTestId('take-countdown')).toBeVisible({ timeout: 10_000 })
  await expect(guest.getByTestId('take-countdown')).toBeVisible()
  await expect(host.locator('.clap-flash')).toContainText('from Host', { timeout: 15_000 })
  await expect(guest.locator('.clap-flash')).toContainText('from Host', { timeout: 15_000 })
  await expect(host.getByTestId('take-marker')).toHaveAttribute('data-take-ready', 'true', { timeout: 15_000 })
  await expect(guest.getByTestId('take-marker')).toHaveAttribute('data-take-ready', 'true')
  const hostStart = Number(await host.getByTestId('take-marker').getAttribute('data-take-start-sample'))
  const guestStart = Number(await guest.getByTestId('take-marker').getAttribute('data-take-start-sample'))
  expect(hostStart).toBeGreaterThanOrEqual(0)
  expect(guestStart).toBeGreaterThanOrEqual(0)

  await guest.close()
  await host.close()
})

for (const action of ['Back to room', 'Escape']) {
  test(`both escape check screens with ${action}, explicitly reopen, and preserve Stop request priority`, async ({ browser }) => {
    const host = await browser.newPage(), guest = await browser.newPage()
    await stubYouTubeApi(host); await stubYouTubeApi(guest)
    const password = 'check-escape'
    const url = await createRoom(host, { name: `Escape ${Date.now()}`, password })
    await joinAsGuest(guest, url, { name: 'Alex', password })
    await host.getByRole('button', { name: 'Start Recording' }).click()
    await expectCheckQuiet(guest, 'host')
    if (action === 'Escape') await guest.keyboard.press('Escape')
    else await guest.getByRole('button', { name: action }).click()
    await expect(guest.getByRole('button', { name: 'Show check' })).toBeVisible()
    if (action === 'Escape') await host.keyboard.press('Escape')
    else await host.getByRole('button', { name: 'Skip microphone check' }).click()
    await expect(host.getByRole('dialog')).toHaveCount(0)
    await expect(guest.getByRole('dialog')).toHaveCount(0)
    await expect(guest.getByTestId('check-turn')).toHaveAttribute('data-check-turn', 'guest')
    await host.keyboard.press('Escape')
    await guest.getByRole('button', { name: 'Show check' }).click()
    await expect(guest.getByRole('dialog', { name: 'Test your microphone?' })).toBeVisible()
    if (action === 'Escape') await guest.keyboard.press('Escape')
    else await guest.getByRole('button', { name: 'Skip microphone check' }).click()
    await expect(host.getByTestId('check-turn')).toHaveAttribute('data-both-turns-passed', 'true')
    await expect(guest.getByRole('button', { name: 'Show check' })).toHaveCount(0)
    await guest.close(); await host.close()
  })
}

for (const accept of [false, true]) {
test(`guest Stop request yields host check and ${accept ? 'acceptance finalizes both recorders' : 'decline leaves explicit Show check'}`, async ({ browser }) => {
  const host = await browser.newPage(), guest = await browser.newPage()
  await stubYouTubeApi(host); await stubYouTubeApi(guest)
  const password = 'check-priority'
  const url = await createRoom(host, { name: `Priority ${Date.now()}`, password })
  await joinAsGuest(guest, url, { name: 'Alex', password })
  await host.getByRole('button', { name: 'Start Recording' }).click()
  await guest.getByRole('button', { name: 'Back to room' }).click()
  await guest.getByRole('button', { name: 'Request to stop recording' }).click()
  await expect(host.getByRole('dialog', { name: 'Test your microphone?' })).toHaveCount(0)
  await expect(host.getByRole('dialog', { name: 'Stop recording?' })).toBeVisible()
  if (accept) {
    await host.getByRole('button', { name: 'Yes, stop' }).click()
    await expect(host.getByRole('button', { name: 'Start Recording' })).toBeVisible()
    await expect(guest.getByRole('button', { name: 'Request to start recording' })).toBeVisible()
    await expect(host.getByRole('button', { name: 'Show check' })).toHaveCount(0)
    await expect(guest.getByRole('button', { name: 'Show check' })).toHaveCount(0)
  } else {
    await host.getByRole('button', { name: 'No', exact: true }).click()
    await expect(host.getByRole('button', { name: 'Show check' })).toBeVisible()
    await expect(guest.getByRole('button', { name: 'Request to stop recording' })).toBeVisible()
    await expect(host.getByTestId('check-turn')).toHaveAttribute('data-check-turn', 'host')
  }
  await guest.close(); await host.close()
})

}

for (const stage of ['close', 'open', 'ready']) {
  test(`retaking Back to room and Stop do not await held ${stage} I/O or reopen a check`, async ({ page }) => {
    await stubYouTubeApi(page)
    await page.addInitScript((stage) => {
      const RealWorklet = window.AudioWorkletNode
      window.AudioWorkletNode = class extends RealWorklet {
        constructor(...args) {
          super(...args)
          const send = this.port.postMessage.bind(this.port)
          this.port.postMessage = (message, ...rest) => {
            if (message.type === 'stop') window.__captureStopCount = (window.__captureStopCount || 0) + 1
            return send(message, ...rest)
          }
        }
      }
      const RealWorker = window.Worker
      window.Worker = class extends RealWorker {
        postMessage(message, ...args) {
          if (window.__holdCheckIO && message.op === stage) {
            window.__releaseCheckIO = () => { window.__holdCheckIO = false; super.postMessage(message, ...args) }
          } else super.postMessage(message, ...args)
        }
      }
    }, stage === 'ready' ? 'close' : stage)
    await createRoom(page, { name: `Held ${stage} ${Date.now()}`, password: 'check-retake' })
    await page.getByRole('button', { name: 'Start Recording' }).click()
    await expect(async () => {
      await page.getByRole('button', { name: 'Listen back' }).click()
      await expect(page.getByRole('button', { name: /Something.s wrong/ })).toBeVisible({ timeout: 500 })
    }).toPass()
    await page.evaluate(() => { window.__holdCheckIO = true })
    await page.getByRole('button', { name: /Something.s wrong/ }).click()
    await expect.poll(() => page.evaluate(() => typeof window.__releaseCheckIO)).toBe('function')
    await page.getByRole('button', { name: 'Back to room' }).click()
    await expect(page.getByRole('button', { name: 'Show check' })).toBeVisible()
    if (stage === 'ready') {
      await page.evaluate(() => window.__releaseCheckIO())
      await expect(page.getByRole('dialog')).toHaveCount(0)
      await page.getByRole('button', { name: 'Show check' }).click()
      await expect(page.getByRole('dialog', { name: 'Test your microphone?' })).toBeVisible()
      await page.keyboard.press('Escape')
    }
    await page.getByRole('button', { name: 'Stop Recording' }).click()
    await page.getByRole('button', { name: 'Stop for both' }).click()
    await expect(page.getByRole('button', { name: 'Show check' })).toHaveCount(0)
    if (stage !== 'ready') await page.evaluate(() => window.__releaseCheckIO())
    await expect(page.getByRole('button', { name: 'Start Recording' })).toBeVisible()
    await expect.poll(() => page.evaluate(() => window.__captureStopCount || 0)).toBeGreaterThan(0)
    await expect(page.getByRole('dialog', { name: 'Test your microphone?' })).toHaveCount(0)
  })
}

for (const action of ['Back to room', 'Escape']) {
  test(`host can leave waiting with ${action} while the guest remains pending`, async ({ browser }) => {
    const host = await browser.newPage(), guest = await browser.newPage()
    await stubYouTubeApi(host); await stubYouTubeApi(guest)
    const password = 'host-wait-exit'
    const url = await createRoom(host, { name: `Host waiting ${Date.now()}`, password })
    await joinAsGuest(guest, url, { name: 'Alex', password })
    await host.getByRole('button', { name: 'Start Recording' }).click()
    await passRecordingCheck(host)
    await expectCheckQuiet(host, 'guest')
    if (action === 'Escape') await host.keyboard.press('Escape')
    else await host.getByRole('button', { name: action }).click()
    await expect(host.getByRole('dialog')).toHaveCount(0)
    await expect(host.getByRole('button', { name: 'Show check' })).toBeVisible()
    await expect(guest.getByRole('dialog', { name: 'Test your microphone?' })).toBeVisible()
    await expect(host.getByTestId('check-turn')).toHaveAttribute('data-both-turns-passed', 'false')
    await guest.close(); await host.close()
  })
}


test('socket replay and a changed turn preserve guest dismissal without rolling either file', async ({ browser }) => {
  const host = await browser.newPage(), guest = await browser.newPage()
  await stubYouTubeApi(host); await stubYouTubeApi(guest); await trackLiveSockets(guest)
  const password = 'check-replay'
  const url = await createRoom(host, { name: `Replay ${Date.now()}`, password })
  await joinAsGuest(guest, url, { name: 'Alex', password })
  await host.getByRole('button', { name: 'Start Recording' }).click()
  await guest.getByRole('button', { name: 'Back to room' }).click()
  const original = await localCopyFiles(guest)
  await closeLiveSockets(guest)
  await expect.poll(() => guest.evaluate(() => window.__prLiveSockets?.some(ws => ws.readyState === WebSocket.OPEN))).toBe(true)
  await expect(guest.getByRole('button', { name: 'Show check' })).toBeVisible()
  await expect(guest.getByRole('dialog')).toHaveCount(0)
  await passRecordingCheck(host)
  await expect(guest.getByTestId('check-turn')).toHaveAttribute('data-check-turn', 'guest')
  await expect(guest.getByRole('dialog')).toHaveCount(0)
  expect(await localCopyFiles(guest)).toEqual(original)
  await guest.getByRole('button', { name: 'Show check' }).click()
  await passRecordingCheck(guest)
  await guest.close(); await host.close()
})
