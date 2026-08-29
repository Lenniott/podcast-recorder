import { test, expect } from '@playwright/test'
import { stubYouTubeApi, createRoom, loadVideo } from './helpers.js'

test('Talk only appears while playing and ducks volume while held', async ({ page }) => {
  await stubYouTubeApi(page)
  await createRoom(page, { name: `E2E Talk ${Date.now()}`, password: 'talk' })
  await loadVideo(page)

  await expect(page.getByRole('button', { name: 'Talk' })).toHaveCount(0)

  await page.getByRole('button', { name: 'Play' }).click()
  const talk = page.getByRole('button', { name: 'Talk' })
  await expect(talk).toBeVisible()

  await talk.hover()
  await page.mouse.down()
  await expect.poll(() => page.evaluate(() => window.__ytVolume)).toBe(25)
  await page.mouse.up()
  await expect.poll(() => page.evaluate(() => window.__ytVolume)).toBe(100)
})
