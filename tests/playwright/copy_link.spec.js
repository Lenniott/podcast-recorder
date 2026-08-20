import { test, expect } from '@playwright/test'
import { stubYouTubeApi, createRoom } from './helpers.js'

test('copy link puts the room url on the clipboard', async ({ page, context }) => {
  await context.grantPermissions(['clipboard-read', 'clipboard-write'])
  await stubYouTubeApi(page)
  await createRoom(page, { name: `E2E CopyLink ${Date.now()}`, password: 'copy-link' })

  await expect(page.locator('.rd-slug')).toContainText('/rec/')
  await page.getByRole('button', { name: '📋' }).click()
  await expect(page.getByRole('button', { name: '👍' })).toBeVisible()
})
