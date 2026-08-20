import { test, expect } from '@playwright/test'
import { stubYouTubeApi, createRoom } from './helpers.js'

test('adding a tab makes Tab 2 the active tab', async ({ page }) => {
  await stubYouTubeApi(page)
  await createRoom(page, { name: `E2E AddTab ${Date.now()}`, password: 'add-tab' })

  await expect(page.getByRole('button', { name: 'Tab 1' })).toBeVisible()
  await expect(page.getByRole('button', { name: 'Close Tab 1' })).toHaveCount(0)

  await page.getByRole('button', { name: 'Add tab' }).click()

  await expect(page.locator('.tab-pill.active')).toContainText('Tab 2')
  await expect(page.getByRole('button', { name: 'Close Tab 1' })).toBeVisible()
  await expect(page.getByRole('button', { name: 'Close Tab 2' })).toBeVisible()
})
