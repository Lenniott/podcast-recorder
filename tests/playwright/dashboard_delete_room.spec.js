import { test, expect } from '@playwright/test'
import { stubYouTubeApi, createRoom, unlockIfNeeded } from './helpers.js'

// Names must not start with "E2E " — that prefix is hidden from the
// dashboard when HIDE_TEST_ROOMS_IN_DASHBOARD is on.
test('host can delete a room from the dashboard after confirming', async ({ page }) => {
  const stamp = Date.now()
  const name = `Dash Delete ${stamp}`

  await stubYouTubeApi(page)
  const roomUrl = await createRoom(page, { name, password: 'delete-pass' })
  const slug = new URL(roomUrl).pathname.split('/').pop()

  await page.goto('/')
  await unlockIfNeeded(page)

  await page.getByRole('textbox', { name: 'Search rooms' }).fill(`Delete ${stamp}`)
  await expect(page.getByRole('link', { name, exact: true })).toBeVisible()

  await page.getByRole('button', { name: 'Delete', exact: true }).click()

  const dialog = page.getByRole('dialog')
  await expect(dialog).toBeVisible()
  await expect(dialog).toContainText('server audio')
  await expect(dialog).toContainText('Research Assistant entries')
  await expect(dialog).toContainText('tab content')
  await expect(dialog).toContainText('transcript')
  await expect(dialog).toContainText('annotations')
  await expect(dialog).toContainText("local recordings on each person's computer are not deleted")
  await expect(dialog).toContainText(name)

  await page.getByRole('button', { name: 'Delete room', exact: true }).click()

  await page.getByRole('textbox', { name: 'Search rooms' }).fill(`Delete ${stamp}`)
  await expect(page.getByRole('link', { name, exact: true })).toHaveCount(0)
  await expect(page.getByText('No rooms match.')).toBeVisible()

  await page.goto(`/rec/${slug}`)
  await expect(page).toHaveURL(/\/\?notfound=1/)
  await unlockIfNeeded(page)
  await expect(page.getByText('Room not found')).toBeVisible()
})

test('cancel on the delete modal leaves the room intact and enterable', async ({ page }) => {
  const stamp = Date.now()
  const name = `Dash Keep ${stamp}`

  await stubYouTubeApi(page)
  const roomUrl = await createRoom(page, { name, password: 'delete-pass' })
  const slug = new URL(roomUrl).pathname.split('/').pop()

  await page.goto('/')
  await unlockIfNeeded(page)

  await page.getByRole('textbox', { name: 'Search rooms' }).fill(`Keep ${stamp}`)
  await expect(page.getByRole('link', { name, exact: true })).toBeVisible()

  await page.getByRole('button', { name: 'Delete', exact: true }).click()
  await expect(page.getByRole('dialog')).toBeVisible()
  await page.getByRole('button', { name: 'Cancel', exact: true }).click()
  await expect(page.getByRole('dialog')).toBeHidden()

  const link = page.getByRole('link', { name, exact: true })
  await expect(link).toBeVisible()
  await link.click()
  await expect(page).toHaveURL(new RegExp(`/rec/${slug}$`))
})
