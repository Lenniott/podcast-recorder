import { test, expect } from '@playwright/test'
import { stubYouTubeApi, createRoom, unlockIfNeeded } from './helpers.js'

test('host can search the dashboard, enter a room, and see its created date', async ({ page }) => {
  const stamp = Date.now()
  const findName = `Dash Find ${stamp}`
  const otherName = `Dash Other ${stamp}`

  await stubYouTubeApi(page)
  const findUrl = await createRoom(page, { name: findName, password: 'dash-find' })
  const slug = new URL(findUrl).pathname.split('/').pop()

  await createRoom(page, { name: otherName, password: 'dash-other' })

  await page.goto('/')
  await unlockIfNeeded(page)

  await page.getByRole('textbox', { name: 'Search rooms' }).fill(`Find ${stamp}`)
  await expect(page.getByRole('link', { name: findName, exact: true })).toBeVisible()
  await expect(page.getByText(otherName, { exact: true })).toHaveCount(0)

  await page.getByRole('link', { name: findName, exact: true }).click()
  await expect(page).toHaveURL(new RegExp(`/rec/${slug}$`))

  await page.goto('/')
  await unlockIfNeeded(page)

  const row = page.getByRole('row').filter({ has: page.getByRole('link', { name: findName, exact: true }) })
  await expect(row.getByRole('cell', { name: /\d{1,2} [A-Z][a-z]{2} \d{4}, \d{2}:\d{2} UTC/ })).toBeVisible()

  await page.getByRole('textbox', { name: 'Search rooms' }).fill('zzz-no-such-room')
  await expect(page.getByText('No rooms match.')).toBeVisible()
})
