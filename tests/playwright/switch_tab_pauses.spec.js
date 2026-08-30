import { test, expect } from '@playwright/test'
import { stubYouTubeApi, createRoom, loadVideo } from './helpers.js'

test('switching away from a playing tab pauses it and does not auto-resume', async ({ page }) => {
  await stubYouTubeApi(page)
  await createRoom(page, { name: `E2E SwitchPause ${Date.now()}`, password: 'switch-pause' })
  await loadVideo(page)

  await page.getByRole('button', { name: 'Play' }).click()
  await expect(page.getByRole('button', { name: 'Pause' })).toBeVisible()

  await page.getByRole('button', { name: 'Add tab' }).click()
  await expect(page.locator('.tab-pill.active')).toContainText('Tab 2')
  await page.waitForTimeout(500)

  await page.getByRole('button', { name: 'Tab 1', exact: true }).click()
  await expect(page.locator('.tab-pill.active')).toContainText('Tab 1')
  await expect(page.getByRole('button', { name: 'Play' })).toBeVisible()
  await page.waitForTimeout(500)
  await expect(page.getByRole('button', { name: 'Play' })).toBeVisible()
})
