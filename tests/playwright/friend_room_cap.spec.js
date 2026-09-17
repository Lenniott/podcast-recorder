import { test, expect } from '@playwright/test'
import { fillField, openCreateRoom } from './helpers.js'

/**
 * Friend room cap (friend-password-auth, ticket 03) — at most 3 active
 * Friend rooms globally; a 4th create attempt lands on a Rooms-full view
 * listing those 3 with time remaining, soonest first; a slot frees up on
 * its own once one of the 3 actually expires. See CONTEXT.md's **Friend
 * room cap** and **Rooms full** entries and
 * .scratch/friend-password-auth/issues/03-friend-room-cap-and-wait-page.md.
 *
 * Like friend_login.spec.js, this only exercises anything when the server
 * under test has both SITE_PASSWORD and FRIEND_PASSWORD configured —
 * playwright.config.js's shared e2e webServer deliberately blanks
 * SITE_PASSWORD, so a normal `npm run test:e2e` run skips this spec.
 *
 * Proving real expiry-driven unblocking additionally needs
 * FRIEND_ROOM_MAX_AGE_HOURS set very low (e.g. '0.001', a few seconds) on
 * the server under test — the shared e2e server never sets it, so that
 * part of this spec self-skips too unless FRIEND_ROOM_MAX_AGE_HOURS_TEST_SECS
 * is set to tell this spec how long to wait for a seeded room to expire.
 * Run for real against a server started with SITE_PASSWORD, FRIEND_PASSWORD,
 * a very small FRIEND_ROOM_MAX_AGE_HOURS, and
 * FRIEND_ROOM_MAX_AGE_HOURS_TEST_SECS set to a matching number of seconds.
 */

async function friendLogin(page, password) {
  await page.goto('/')
  const friendField = page.getByRole('textbox', { name: 'Friend Password' })
  const newRoom = page.getByRole('button', { name: 'New room' })
  await expect(friendField.or(newRoom)).toBeVisible({ timeout: 15_000 })
  test.skip(!(await friendField.isVisible()), 'Friend login gate is off (FRIEND_PASSWORD not set on this server)')
  await friendField.fill(password)
  await page.getByRole('button', { name: 'Unlock' }).click()
  await expect(newRoom).toBeVisible({ timeout: 15_000 })
}

// Submits the create form and returns without waiting for a `/rec/` — the
// caller decides what should happen next (a redirect, or the Rooms-full view
// appearing in place on this same page).
async function submitCreateRoom(page, { name, password }) {
  await openCreateRoom(page)
  await fillField(page.locator('#room-episode-name'), name)
  await fillField(page.locator('#room-episode-code'), password)
  await page.getByRole('button', { name: /Create Room/i }).click()
}

async function createFriendRoomAndReturnHome(page, name) {
  await submitCreateRoom(page, { name, password: 'friend-room-pass' })
  await page.waitForURL(/\/rec\//, { timeout: 30_000 })
  // Leave the room without joining as a participant — only room *existence*
  // (and its created_at) matters for the cap, not anyone being in it.
  await page.goto('/')
  await expect(page.getByRole('button', { name: 'New room' })).toBeVisible({ timeout: 15_000 })
}

test('Friend room cap: a 4th create attempt lands on Rooms full with the 3 active rooms and countdowns, soonest first', async ({ page }) => {
  await friendLogin(page, process.env.FRIEND_PASSWORD || '')

  const stamp = Date.now()
  const roomNames = [1, 2, 3].map((n) => `E2E FriendCap ${stamp}-${n}`)
  for (const name of roomNames) {
    await createFriendRoomAndReturnHome(page, name)
  }

  // 4th attempt: no room created, no bare validation error — the Rooms-full
  // view renders in place of the create-room banner, and the modal closes.
  await submitCreateRoom(page, { name: `E2E FriendCap ${stamp}-4`, password: 'friend-room-pass' })
  await expect(page.getByText('Rooms full', { exact: false })).toBeVisible({ timeout: 15_000 })
  await expect(page.locator('#room-episode-name')).not.toBeVisible()

  // Exactly the 3 rooms just created are listed, each with a countdown —
  // order (soonest-to-expire first) follows creation order since they were
  // all created on the same clock, oldest first.
  const listedNames = await page.locator('.rooms-full-list li .room-name').allTextContents()
  expect(listedNames).toEqual(roomNames)
  const listedExpiries = await page.locator('.rooms-full-list li .room-expires').allTextContents()
  expect(listedExpiries).toHaveLength(3)
  for (const text of listedExpiries) expect(text).toMatch(/expires in/)
})

test('Friend room cap: once a room actually expires, a Friend can create a new one with no manual step', async ({ page }) => {
  const expirySecs = Number(process.env.FRIEND_ROOM_MAX_AGE_HOURS_TEST_SECS || '')
  test.skip(!expirySecs, 'FRIEND_ROOM_MAX_AGE_HOURS_TEST_SECS not set — see this file\'s header comment')

  await friendLogin(page, process.env.FRIEND_PASSWORD || '')

  const stamp = Date.now()
  const roomNames = [1, 2, 3].map((n) => `E2E FriendCapExpiry ${stamp}-${n}`)
  for (const name of roomNames) {
    await createFriendRoomAndReturnHome(page, name)
  }

  await submitCreateRoom(page, { name: `E2E FriendCapExpiry ${stamp}-blocked`, password: 'friend-room-pass' })
  await expect(page.getByText('Rooms full', { exact: false })).toBeVisible({ timeout: 15_000 })

  // Wait past the oldest room's expiry (server-side sweep is periodic — see
  // expired-room-cleanup.js — but getFriendRoomCapStatus re-checks live at
  // create time regardless, so no sweep needs to have run yet).
  await page.waitForTimeout((expirySecs + 2) * 1000)

  await page.goto('/')
  await submitCreateRoom(page, { name: `E2E FriendCapExpiry ${stamp}-new`, password: 'friend-room-pass' })
  await page.waitForURL(/\/rec\//, { timeout: 30_000 })
})
