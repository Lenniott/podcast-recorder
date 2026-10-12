import { test, expect } from '@playwright/test'
import Database from 'better-sqlite3'
import { mkdirSync, writeFileSync } from 'fs'
import { join } from 'path'
import { createRoom, joinAsGuest, stubYouTubeApi, unlockIfNeeded } from './helpers.js'

test('guest lock starts after server audio, and Unlock lets a guest back in', async ({ browser }) => {
  const host = await browser.newPage()
  await stubYouTubeApi(host)
  const name = `Dash Lock ${Date.now()}`
  const password = 'lock-pass'
  const roomUrl = await createRoom(host, {
    name,
    password,
    hostDisplayName: 'Host'
  })
  const slug = new URL(roomUrl).pathname.split('/').filter(Boolean).pop()

  const db = new Database('./data/e2e-rooms.db')
  try {
    const before = db.prepare('SELECT created_at FROM rooms WHERE slug = ?').get(slug)
    const info = db.prepare('UPDATE rooms SET guest_lock_at = ? WHERE slug = ?').run(
      Date.now() - 13 * 60 * 60 * 1000,
      slug
    )
    expect(info.changes).toBe(1)
    const after = db.prepare('SELECT created_at FROM rooms WHERE slug = ?').get(slug)
    expect(after.created_at).toBe(before.created_at)
  } finally {
    db.close()
  }

  // Fresh context: no host cookie, so this join is a guest.
  const guest = await browser.newPage()
  await stubYouTubeApi(guest)
  await joinAsGuest(guest, roomUrl, { name: 'Guest', password })

  mkdirSync(join('./data/server-copies', slug), { recursive: true })
  writeFileSync(join('./data/server-copies', slug, 'e2e-client.wav'), Buffer.from([1, 2, 3, 4]))

  await guest.goto(roomUrl)
  await expect(guest).toHaveURL(/\/\?guestlocked=1/)
  await expect(guest.getByText('That room is locked for guests. The host can still enter.')).toBeVisible()

  await host.goto('/')
  await unlockIfNeeded(host)
  const row = host.locator('tr', { has: host.getByRole('link', { name, exact: true }) })
  await expect(row.getByText('Guests locked', { exact: true })).toBeVisible()
  const createdText = (await row.getByText(/\d{1,2} [A-Z][a-z]{2} \d{4}, \d{2}:\d{2} UTC/).textContent()).trim()

  await row.getByRole('link', { name, exact: true }).click()
  await expect(host).toHaveURL(new RegExp(`/rec/${slug}$`))

  await host.goto('/')
  await unlockIfNeeded(host)
  await row.getByRole('button', { name: 'Unlock', exact: true }).click()
  await expect(row.getByText('Open to guests', { exact: true })).toBeVisible()
  await expect(row.getByText(createdText, { exact: true })).toBeVisible()

  // joinAsGuest fills the password gate. Clear the session from the first
  // successful join so this is another password entry, not a resume.
  await guest.context().clearCookies()
  await joinAsGuest(guest, roomUrl, { name: 'Guest', password })
  await expect(guest.getByRole('button', { name: 'Start Recording' })).toBeVisible()

  await guest.close()
  await host.close()
})
