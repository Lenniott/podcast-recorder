import { test, expect } from '@playwright/test'
import { stubYouTubeApi, createRoom, joinAsGuest, passRecordingCheck, expandPresenceTable, presenceRow } from './helpers.js'

test('host can play the guest listen-back clip from the presence table without downloading', async ({ browser }) => {
  const host = await browser.newPage()
  await stubYouTubeApi(host)
  const password = 'check-preview-listen'
  const roomUrl = await createRoom(host, { name: `E2E Check Preview ${Date.now()}`, password })

  const guest = await browser.newPage()
  await stubYouTubeApi(guest)
  await joinAsGuest(guest, roomUrl, { name: 'Alex', password })

  await expandPresenceTable(host)
  await expect(guest.getByRole('button', { name: 'Start Recording' })).toBeEnabled()
  await guest.getByRole('button', { name: 'Start Recording' }).click()
  await expect(guest.getByRole('button', { name: 'Stop Recording' })).toBeVisible()

  await expect(presenceRow(host, 'Alex').getByTestId('check-preview-waiting')).toBeVisible()
  await expect(presenceRow(guest, 'Host').getByTestId('check-preview-play')).toHaveCount(0)

  await passRecordingCheck(guest)

  const play = presenceRow(host, 'Alex').getByTestId('check-preview-play')
  await expect(play).toBeVisible({ timeout: 15_000 })
  await play.click()
  await expect.poll(async () => {
    return host.locator('.check-preview-audio').evaluate((el) => el.src || '')
  }).toMatch(/^blob:/)

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
  await guest.getByRole('button', { name: 'Start Recording' }).click()
  await expect(guest.getByRole('button', { name: 'Stop Recording' })).toBeVisible()
  await expect(guest.locator('.check-overlay')).toBeVisible()

  await expect(presenceRow(host, 'Alex').getByTestId('check-preview-play')).toBeVisible({ timeout: 20_000 })

  await guest.close()
  await host.close()
})
