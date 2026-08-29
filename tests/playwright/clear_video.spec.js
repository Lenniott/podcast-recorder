import { test, expect } from '@playwright/test'
import { stubYouTubeApi, createRoom, loadVideo } from './helpers.js'

test('Clear video returns to the paste-URL row', async ({ page }) => {
  await stubYouTubeApi(page)
  await createRoom(page, { name: `E2E ClearVideo ${Date.now()}`, password: 'clear-video' })
  await loadVideo(page)

  await page.getByRole('button', { name: 'Clear video' }).click()

  await expect(page.getByPlaceholder('Paste a YouTube link or video id')).toBeVisible()
  await expect(page.getByRole('button', { name: 'Watch' })).toBeVisible()
  await expect(page.getByRole('button', { name: 'Play' })).toHaveCount(0)
})
