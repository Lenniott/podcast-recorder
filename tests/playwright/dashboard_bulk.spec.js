import { test, expect } from '@playwright/test'
import Database from 'better-sqlite3'
import { mkdirSync, writeFileSync } from 'fs'
import { join } from 'path'
import { E2E_SERVER_COPY_DIR, E2E_DB_PATH, createRoom, stubYouTubeApi, unlockIfNeeded } from './helpers.js'

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
  const nameA = `Dash Pair ${stamp} A`
  const nameB = `Dash Pair ${stamp} B`
  const nameC = `Dash Solo ${stamp} C`

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

  const db = new Database(E2E_DB_PATH)
  try {
    const lockedAt = Date.now() - 13 * 60 * 60 * 1000
    const update = db.prepare('UPDATE rooms SET guest_lock_at = ? WHERE slug = ?')
    for (const slug of [slugA, slugB]) {
      expect(update.run(lockedAt, slug).changes).toBe(1)
      mkdirSync(join(E2E_SERVER_COPY_DIR, slug), { recursive: true })
      writeFileSync(join(E2E_SERVER_COPY_DIR, slug, 'hostbulk.wav'), Buffer.alloc(320))
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
  const nameA = `Dash Bulk ${stamp} A`
  const nameB = `Dash Bulk ${stamp} B`
  const nameC = `Dash Kept ${stamp} C`

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


test('changing search clears hidden selections and empty actions send no request', async ({ page }) => {
  const stamp = Date.now()
  await stubYouTubeApi(page)
  await createRoom(page, { name: `Dash Selection ${stamp}`, password: 'selection-pass' })
  await page.goto('/')
  await unlockIfNeeded(page)
  const search = page.getByRole('textbox', { name: 'Search rooms' })
  await search.fill(`Selection ${stamp}`)
  await page.getByRole('checkbox', { name: 'Select all visible rooms' }).click()
  await expect(page.getByRole('button', { name: 'Delete selected', exact: true })).toBeEnabled()
  await expect(page.getByRole('button', { name: 'Unlock selected', exact: true })).toBeDisabled()
  await search.fill('no-such-selection')
  await expect(page.getByText('No rooms match.')).toBeVisible()
  await expect(page.getByRole('button', { name: 'Unlock selected', exact: true })).toBeDisabled()
  await expect(page.getByRole('button', { name: 'Delete selected', exact: true })).toBeDisabled()
  const posts = []
  page.on('request', request => { if (request.method() === 'POST') posts.push(request.url()) })
  await page.locator('form[action="?/unlock_rooms"]').evaluate(form => form.requestSubmit())
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))))
  expect(posts).toEqual([])
})

test('row checkmarks follow mouse and keyboard selection, including select-all', async ({ page }) => {
  const stamp = Date.now()
  const nameA = `Dash Checks ${stamp} A`
  const nameB = `Dash Checks ${stamp} B`
  await stubYouTubeApi(page)
  await createRoom(page, { name: nameA, password: 'checks-pass' })
  await createRoom(page, { name: nameB, password: 'checks-pass' })
  await page.goto('/')
  await unlockIfNeeded(page)
  await page.getByRole('textbox', { name: 'Search rooms' }).fill(`Checks ${stamp}`)
  const rowA = page.getByRole('checkbox', { name: `Select ${nameA}`, exact: true })
  const rowB = page.getByRole('checkbox', { name: `Select ${nameB}`, exact: true })
  const all = page.getByRole('checkbox', { name: 'Select all visible rooms', exact: true })
  const unlock = page.getByRole('button', { name: 'Unlock selected', exact: true })

  await rowA.click()
  await expect(rowA).toBeChecked()
  await expect(rowB).not.toBeChecked()
  await expect(all).not.toBeChecked()
  await expect(unlock).toBeDisabled()
  await expect(page.getByRole('button', { name: 'Delete selected', exact: true })).toBeEnabled()

  await rowB.click()
  await expect(rowB).toBeChecked()
  await expect(all).toBeChecked()
  await rowA.click()
  await expect(rowA).not.toBeChecked()
  await expect(rowB).toBeChecked()
  await expect(all).not.toBeChecked()

  await rowA.press('Space')
  await expect(rowA).toBeChecked()
  await expect(all).toBeChecked()
  await all.click()
  await expect(all).not.toBeChecked()
  await expect(rowA).not.toBeChecked()
  await expect(rowB).not.toBeChecked()
  await expect(unlock).toBeDisabled()

  await all.press('Space')
  await expect(all).toBeChecked()
  await expect(rowA).toBeChecked()
  await expect(rowB).toBeChecked()
})
