import { test, expect } from '@playwright/test'
import { stubYouTubeApi, createRoom } from './helpers.js'

test('create room lands the host in the recording room', async ({ page }) => {
  await stubYouTubeApi(page)
  await createRoom(page, { name: `E2E CreateRoom ${Date.now()}`, password: 'test', hostDisplayName: 'tester' })

  await expect(page).toHaveURL(/\/rec\//)
  await expect(page.getByRole('button', { name: 'Collapse sidebar' })).toBeVisible()
  await expect(page.getByRole('button', { name: 'Tab 1' })).toBeVisible()
  await expect(page.getByRole('button', { name: 'Start Recording' })).toBeVisible()
})
