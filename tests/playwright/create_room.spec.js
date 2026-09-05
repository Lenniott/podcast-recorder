import { test, expect } from '@playwright/test'
import { stubYouTubeApi, createRoom, fillField, openCreateRoom, unlockIfNeeded } from './helpers.js'

const createDialog = (page) => page.getByRole('dialog', { name: 'Create a new episode' })

test('create room lands the host in the recording room', async ({ page }) => {
  await stubYouTubeApi(page)
  await createRoom(page, { name: `E2E CreateRoom ${Date.now()}`, password: 'test', hostDisplayName: 'tester' })

  await expect(page).toHaveURL(/\/rec\//)
  await expect(page.getByRole('button', { name: 'Collapse sidebar' })).toBeVisible()
  await expect(page.getByRole('button', { name: 'Tab 1' })).toBeVisible()
  await expect(page.getByRole('button', { name: 'Start Recording' })).toBeVisible()
})

test('create episode modal opens from New room, dismisses, and stays open on a failed create', async ({ page }) => {
  await page.goto('/')
  await unlockIfNeeded(page)

  await expect(page.getByRole('button', { name: 'New room' })).toBeVisible()
  await expect(createDialog(page)).toHaveCount(0)
  await expect(page.locator('#room-episode-name')).toHaveCount(0)

  await openCreateRoom(page)
  await expect(createDialog(page)).toBeVisible()

  await page.getByRole('button', { name: 'Close' }).click()
  await expect(createDialog(page)).toHaveCount(0)

  await openCreateRoom(page)
  await page.keyboard.press('Escape')
  await expect(createDialog(page)).toHaveCount(0)

  await openCreateRoom(page)
  await fillField(page.locator('#room-episode-name'), '   ')
  await fillField(page.locator('#room-episode-code'), 'pass')
  await page.getByRole('button', { name: /Create Room/i }).click()

  await expect(createDialog(page)).toBeVisible()
  await expect(page.getByText('Episode name is required')).toBeVisible()
})
