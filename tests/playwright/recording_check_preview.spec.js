import { test, expect } from '@playwright/test'
import {
  stubYouTubeApi,
  createRoom,
  joinAsGuest,
  passRecordingCheck,
  expandPresenceTable,
  presenceRow,
  startViaGuestRequest
} from './helpers.js'

test('a rejected listen-back does not pass the check and native controls can recover', async ({ page }) => {
  await stubYouTubeApi(page)
  await createRoom(page, { name: `E2E Playback Failure ${Date.now()}`, password: 'playback-failure' })
  await page.getByRole('button', { name: 'Start Recording' }).click()
  const dialog = page.getByRole('dialog', { name: 'Test your microphone?' })
  await expect(dialog).toBeVisible()

  // Reproduce a browser refusing playback, independently of WAV generation.
  await page.evaluate(() => {
    const nativePlay = HTMLMediaElement.prototype.play
    HTMLMediaElement.prototype.play = function () {
      if (this.closest('[role="dialog"]')) {
        window.retryCheckPlayback = () => nativePlay.call(this)
        return Promise.reject(new DOMException('Playback blocked by browser', 'NotAllowedError'))
      }
      return nativePlay.call(this)
    }
  })
  await expect(async () => {
    await dialog.getByRole('button', { name: 'Listen back' }).click()
    await expect(dialog.locator('audio')).toHaveAttribute('src', /^blob:/, { timeout: 500 })
  }).toPass({ timeout: 10_000 })
  await expect(dialog.getByRole('button', { name: 'Yes, continue' })).toHaveCount(0)
  await expect(dialog.locator('.check-error')).toContainText('Could not play')
  await expect(page.getByRole('button', { name: 'Stop Recording' })).toBeVisible()

  // The browser's audio controls can start the same clip after a failed auto-start.
  await page.evaluate(() => window.retryCheckPlayback())
  await expect(dialog.getByRole('button', { name: 'Yes, continue' })).toBeVisible()
  await expect(dialog.locator('.check-error')).toHaveCount(0)
  await expect.poll(() => dialog.locator('audio').evaluate(el => el.currentTime)).toBeGreaterThan(0)
})

test('host can play the guest listen-back clip from the presence table without downloading', async ({ browser }) => {
  const host = await browser.newPage()
  await stubYouTubeApi(host)
  const password = 'check-preview-listen'
  const roomUrl = await createRoom(host, { name: `E2E Check Preview ${Date.now()}`, password })

  const guest = await browser.newPage()
  await stubYouTubeApi(guest)
  await joinAsGuest(guest, roomUrl, { name: 'Alex', password })

  await expandPresenceTable(host)
  await startViaGuestRequest(host, guest)
  await passRecordingCheck(host)

  await expect(presenceRow(host, 'Alex').getByTestId('check-preview-waiting')).toBeVisible()
  await expect(presenceRow(guest, 'Host').getByTestId('check-preview-play')).toHaveCount(0)

  await passRecordingCheck(guest)

  const play = presenceRow(host, 'Alex').getByTestId('check-preview-play')
  await expect(play).toBeVisible({ timeout: 15_000 })
  await play.click()
  await expect.poll(async () => {
    return host.locator('.check-preview-audio').evaluate((el) => el.src || '')
  }).toMatch(/^blob:/)
  await expect.poll(() => host.locator('.check-preview-audio').evaluate(el => el.currentTime)).toBeGreaterThan(0)
  await expect(host.locator('.check-preview-audio')).toHaveJSProperty('muted', false)
  await expect(host.locator('.check-preview-audio')).toHaveJSProperty('volume', 1)

  await guest.close()
  await host.close()
})

test('host gets the guest test clip automatically without the guest clicking Listen back', async ({ browser }) => {
  const host = await browser.newPage()
  await stubYouTubeApi(host)
  const password = 'check-preview-auto'
  const roomUrl = await createRoom(host, { name: `E2E Check Auto ${Date.now()}`, password })

  const guest = await browser.newPage()
  await stubYouTubeApi(guest)
  await joinAsGuest(guest, roomUrl, { name: 'Alex', password })

  await expandPresenceTable(host)
  await startViaGuestRequest(host, guest)
  await passRecordingCheck(host)
  await expect(guest.getByRole('dialog', { name: 'Test your microphone?' })).toBeVisible()

  await expect(presenceRow(host, 'Alex').getByTestId('check-preview-play')).toBeVisible({ timeout: 20_000 })

  await guest.close()
  await host.close()
})
