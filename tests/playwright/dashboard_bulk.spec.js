import { test, expect } from '@playwright/test'
import Database from 'better-sqlite3'
import { mkdirSync, writeFileSync } from 'fs'
import { join } from 'path'
import { createRoom, stubYouTubeApi, unlockIfNeeded } from './helpers.js'

// Names must not start with "E2E " — that prefix is hidden from the
// dashboard when HIDE_TEST_ROOMS_IN_DASHBOARD is on.

function slugFrom(roomUrl) {
  return new URL(roomUrl).pathname.split('/').filter(Boolean).pop()
}

function rowFor(page, name) {
  return page.locator('tr', { has: page.getByRole('link', { name, exact: true }) })
}

test('select-all covers the search results, and bulk unlock opens those rooms', async ({ page }) => {
  test.setTimeout(120_000)
  const stamp = Date.now()
  const nameA = `Dash Pair A ${stamp}`
  const nameB = `Dash Pair B ${stamp}`
  const nameC = `Dash Solo C ${stamp}`

  await stubYouTubeApi(page)
  const slugA = slugFrom(await createRoom(page, { name: nameA, password: 'bulk-pass' }))
  const slugB = slugFrom(await createRoom(page, { name: nameB, password: 'bulk-pass' }))
  await createRoom(page, { name: nameC, password: 'bulk-pass' })

  await page.goto('/')
  await unlockIfNeeded(page)
  await page.getByRole('textbox', { name: 'Search rooms' }).fill(`Pair ${stamp}`)
  await expect(page.getByRole('link', { name: nameA, exact: true })).toBeVisible()
  await expect(page.getByRole('link', { name: nameB, exact: true })).toBeVisible()

  await page.getByRole('checkbox', { name: 'Select all visible rooms' }).click()
  await expect(page.getByRole('link', { name: nameC, exact: true })).toHaveCount(0)

  const db = new Database('./data/e2e-rooms.db')
  try {
    const lockedAt = Date.now() - 13 * 60 * 60 * 1000
    const update = db.prepare('UPDATE rooms SET guest_lock_at = ? WHERE slug = ?')
    for (const slug of [slugA, slugB]) {
      expect(update.run(lockedAt, slug).changes).toBe(1)
      mkdirSync(join('./data/server-copies', slug), { recursive: true })
      writeFileSync(join('./data/server-copies', slug, 'hostbulk.wav'), Buffer.alloc(320))
    }
  } finally {
    db.close()
  }

  await page.reload()
  await unlockIfNeeded(page)
  await page.getByRole('textbox', { name: 'Search rooms' }).fill(`Pair ${stamp}`)

  const rowA = rowFor(page, nameA)
  const rowB = rowFor(page, nameB)
  await expect(rowA.getByText('Guests locked', { exact: true })).toBeVisible()
  await expect(rowB.getByText('Guests locked', { exact: true })).toBeVisible()
  const createdA = (await rowA.getByText(/\d{1,2} [A-Z][a-z]{2} \d{4}, \d{2}:\d{2} UTC/).textContent()).trim()
  const createdB = (await rowB.getByText(/\d{1,2} [A-Z][a-z]{2} \d{4}, \d{2}:\d{2} UTC/).textContent()).trim()

  await page.getByRole('checkbox', { name: 'Select all visible rooms' }).click()
  await page.getByRole('button', { name: 'Unlock selected', exact: true }).click()

  await expect(rowA.getByText('Open to guests', { exact: true })).toBeVisible()
  await expect(rowB.getByText('Open to guests', { exact: true })).toBeVisible()
  await expect(rowA.getByText(createdA, { exact: true })).toBeVisible()
  await expect(rowB.getByText(createdB, { exact: true })).toBeVisible()
})

test('bulk delete confirms once, and cancel removes nothing', async ({ page }) => {
  test.setTimeout(120_000)
  const stamp = Date.now()
  const nameA = `Dash Bulk A ${stamp}`
  const nameB = `Dash Bulk B ${stamp}`
  const nameC = `Dash Kept C ${stamp}`

  await stubYouTubeApi(page)
  await createRoom(page, { name: nameA, password: 'bulk-pass' })
  await createRoom(page, { name: nameB, password: 'bulk-pass' })
  await createRoom(page, { name: nameC, password: 'bulk-pass' })

  await page.goto('/')
  await unlockIfNeeded(page)
  await page.getByRole('textbox', { name: 'Search rooms' }).fill(`Bulk ${stamp}`)
  await expect(page.getByRole('link', { name: nameA, exact: true })).toBeVisible()
  await expect(page.getByRole('link', { name: nameB, exact: true })).toBeVisible()
  await expect(page.getByRole('link', { name: nameC, exact: true })).toHaveCount(0)

  await page.getByRole('checkbox', { name: 'Select all visible rooms' }).click()
  await page.getByRole('button', { name: 'Delete selected', exact: true }).click()

  const dialog = page.getByRole('dialog')
  await expect(dialog).toBeVisible()
  await expect(dialog).toContainText('server audio')
  await expect(dialog).toContainText('Research Assistant entries')
  await expect(dialog).toContainText('tab content')
  await expect(dialog).toContainText('transcript')
  await expect(dialog).toContainText('annotations')
  await expect(dialog).toContainText("local recordings on each person's computer are not deleted")
  await expect(dialog).toContainText('fully removed')
  await expect(dialog).toContainText('2')

  await page.getByRole('button', { name: 'Cancel', exact: true }).click()
  await expect(dialog).toBeHidden()
  await expect(page.getByRole('link', { name: nameA, exact: true })).toBeVisible()
  await expect(page.getByRole('link', { name: nameB, exact: true })).toBeVisible()

  await page.getByRole('button', { name: 'Delete selected', exact: true }).click()
  await page.getByRole('button', { name: 'Delete selected rooms', exact: true }).click()

  await expect(page.getByRole('link', { name: nameA, exact: true })).toHaveCount(0)
  await expect(page.getByRole('link', { name: nameB, exact: true })).toHaveCount(0)

  await page.getByRole('textbox', { name: 'Search rooms' }).fill('')
  await expect(page.getByRole('link', { name: nameC, exact: true })).toBeVisible()
  await expect(page.getByRole('link', { name: nameA, exact: true })).toHaveCount(0)
  await expect(page.getByRole('link', { name: nameB, exact: true })).toHaveCount(0)
})
