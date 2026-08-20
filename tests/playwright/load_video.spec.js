import { test, expect } from '@playwright/test'
import { stubYouTubeApi, createRoom, loadVideo } from './helpers.js'

test('Watch loads a video and shows Play', async ({ page }) => {
  await stubYouTubeApi(page)
  await createRoom(page, { name: `E2E LoadVideo ${Date.now()}`, password: 'load-video' })

  await loadVideo(page)

  await expect(page.getByRole('button', { name: '▶ Play' })).toBeVisible()
  await expect(page.getByRole('button', { name: 'Clear video' })).toBeVisible()
  await expect(page.getByRole('button', { name: 'Mute' })).toBeVisible()
  await expect(page.getByRole('button', { name: 'Talk' })).toHaveCount(0)
})
