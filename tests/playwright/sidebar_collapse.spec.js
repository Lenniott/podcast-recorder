import { test, expect } from '@playwright/test'
import { stubYouTubeApi, createRoom } from './helpers.js'

test('collapsing hides the mic panel but keeps record and clap', async ({ page }) => {
  await stubYouTubeApi(page)
  await createRoom(page, { name: `E2E SidebarCollapse ${Date.now()}`, password: 'sidebar-collapse' })

  await expect(page.getByRole('combobox', { name: 'Microphone' })).toBeVisible()
  await expect(page.getByRole('button', { name: 'Start Recording' })).toBeVisible()
  await expect(page.getByRole('button', { name: 'Clap' })).toBeVisible()

  await page.getByRole('button', { name: 'Collapse sidebar' }).click()

  await expect(page.getByRole('combobox', { name: 'Microphone' })).toHaveCount(0)
  await expect(page.locator('.waveform-wrap canvas')).toBeVisible()
  await expect(page.getByRole('button', { name: 'Start Recording' })).toBeVisible()
  await expect(page.getByRole('button', { name: 'Clap' })).toBeVisible()

  await page.getByRole('button', { name: 'Expand sidebar' }).click()
  await expect(page.getByRole('combobox', { name: 'Microphone' })).toBeVisible()
  await expect(page.getByRole('button', { name: 'Clap' })).toBeVisible()
})
