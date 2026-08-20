import { test, expect } from '@playwright/test'
import { stubYouTubeApi, createRoom } from './helpers.js'

test('an invalid YouTube link shows an error', async ({ page }) => {
  await stubYouTubeApi(page)
  await createRoom(page, { name: `E2E InvalidVideo ${Date.now()}`, password: 'invalid-video' })

  await page.getByPlaceholder('Paste a YouTube link or video id').fill('not a url')
  await page.getByRole('button', { name: 'Watch' }).click()

  await expect(page.getByText('Could not find a YouTube video in that link.')).toBeVisible()
  await expect(page.getByRole('button', { name: 'Watch' })).toBeVisible()
})
