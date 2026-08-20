import { test, expect } from '@playwright/test'
import { stubYouTubeApi, createRoom, loadVideo } from './helpers.js'

test('mute is local to this browser', async ({ page }) => {
  await stubYouTubeApi(page)
  await createRoom(page, { name: `E2E Mute ${Date.now()}`, password: 'mute' })
  await loadVideo(page)

  await page.getByRole('button', { name: 'Mute' }).click()
  await expect(page.getByRole('button', { name: 'Unmute' })).toBeVisible()
  await page.getByRole('button', { name: 'Unmute' }).click()
  await expect(page.getByRole('button', { name: 'Mute' })).toBeVisible()
})
