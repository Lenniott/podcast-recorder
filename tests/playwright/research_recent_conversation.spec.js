import { test, expect } from '@playwright/test'
import { stubYouTubeApi, createRoom } from './helpers.js'

test('the old Research recent conversation control is gone', async ({ page }) => {
  await stubYouTubeApi(page)
  await createRoom(page, { name: `E2E NoRecent ${Date.now()}`, password: 'no-recent' })
  await expect(page.getByRole('button', { name: 'Research recent conversation' })).toHaveCount(0)
  await expect(page.getByRole('button', { name: 'Define' })).toHaveCount(0)
  await page.close()
})
