import { test, expect } from '@playwright/test'
import Database from 'better-sqlite3'
import { createRoom, stubYouTubeApi, unlockIfNeeded } from './helpers.js'

test('an old room stays on the dashboard and can still be opened', async ({ page }) => {
  await stubYouTubeApi(page)
  const name = `Dash Persist ${Date.now()}`
  const roomUrl = await createRoom(page, {
    name,
    password: 'persist-pass',
    hostDisplayName: 'Host'
  })
  const slug = new URL(roomUrl).pathname.split('/').filter(Boolean).pop()

  const old = Date.now() - 13 * 60 * 60 * 1000
  const db = new Database('./data/e2e-rooms.db')
  try {
    // A missing guest_lock_at column throws here — that means this server
    // does not have the persist migration yet.
    const info = db.prepare(
      'UPDATE rooms SET created_at = ?, guest_lock_at = ? WHERE slug = ?'
    ).run(old, old, slug)
    expect(info.changes).toBe(1)
  } finally {
    db.close()
  }

  await page.goto('/')
  await unlockIfNeeded(page)
  const roomLink = page.getByRole('link', { name, exact: true })
  await expect(roomLink).toBeVisible()
  await roomLink.click()

  await expect(page).toHaveURL(new RegExp(`/rec/${slug}$`))
  const inRoom = page.getByRole('button', { name: 'Start Recording' })
  const nameGate = page.getByLabel('Your name')
  const passwordGate = page.locator('#room-episode-code')
  await expect(inRoom.or(nameGate).or(passwordGate)).toBeVisible()

  await page.goto('/')
  await unlockIfNeeded(page)
  await expect(page.getByRole('link', { name, exact: true })).toBeVisible()
})
