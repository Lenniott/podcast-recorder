import { test, expect } from '@playwright/test'
import { stubYouTubeApi, createRoom } from './helpers.js'

test('closing the active tab falls back to Tab 1', async ({ page }) => {
  await stubYouTubeApi(page)
  await createRoom(page, { name: `E2E CloseTab ${Date.now()}`, password: 'close-tab' })

  await page.getByRole('button', { name: 'Add tab' }).click()
  await expect(page.locator('.tab-pill.active')).toContainText('Tab 2')

  await page.getByRole('button', { name: 'Close Tab 2' }).click()

  await expect(page.locator('.tab-pill.active')).toContainText('Tab 1')
  await expect(page.getByRole('button', { name: 'Tab 2' })).toHaveCount(0)
  await expect(page.getByRole('button', { name: 'Close Tab 1' })).toHaveCount(0)
})
