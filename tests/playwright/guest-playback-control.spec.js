import { test, expect } from '@playwright/test'
import { createRoom, joinAsGuest, stubYouTubeApi } from './helpers.js'

test.describe('Guest playback control', () => {
  test('create form shows guest playback checkbox, off by default', async ({ page }) => {
    await page.goto('/')
    const box = page.locator('#guest_can_control_playback')
    await expect(box).toBeVisible()
    await expect(box).not.toBeChecked()
    await expect(page.getByText('Let your guest play/pause and seek the shared video')).toBeVisible()
  })

  test('host with guest control enabled sees volume + talk button after loading a video', async ({
    page
  }) => {
    await stubYouTubeApi(page)
    const password = 'test-pass-1234'
    await createRoom(page, {
      name: `E2E GuestCtrl ${Date.now()}`,
      password,
      guestCanControl: true
    })

    await expect(page.getByRole('heading', { name: '📺 Watch together' })).toBeVisible()

    await page.getByPlaceholder('Paste a YouTube link or video id').fill('dQw4w9WgXcQ')
    await page.getByRole('button', { name: 'Watch' }).click()

    await expect(page.locator('.watch-volume-slider')).toBeVisible()
    await expect(page.locator('.watch-mute-btn')).toBeVisible()
    const talkBtn = page.getByRole('button', { name: 'Talk' })
    await expect(talkBtn).toBeVisible()
    await expect(talkBtn).toHaveAttribute('aria-pressed', 'false')
    await talkBtn.hover()
    await page.mouse.down()
    await expect(talkBtn).toHaveAttribute('aria-pressed', 'true')
    await page.mouse.up()
    await expect(talkBtn).toHaveAttribute('aria-pressed', 'false')
    await expect(page.locator('.watch-play-btn')).toBeVisible()
  })

  test('guest can play/pause when room opts in; load stays host-only', async ({ browser }) => {
    const host = await browser.newPage()
    await stubYouTubeApi(host)

    const password = 'guest-ctrl-pass'
    const roomUrl = await createRoom(host, {
      name: `E2E GuestPlay ${Date.now()}`,
      password,
      guestCanControl: true
    })

    await host.getByPlaceholder('Paste a YouTube link or video id').fill('dQw4w9WgXcQ')
    await host.getByRole('button', { name: 'Watch' }).click()
    await expect(host.locator('.watch-play-btn')).toBeVisible()

    const guest = await browser.newPage()
    await stubYouTubeApi(guest)
    await joinAsGuest(guest, roomUrl, { name: 'Guest', password })

    // Guest should get playback controls (not the "host controls" hint).
    await expect(guest.locator('.watch-play-btn')).toBeVisible({ timeout: 15_000 })
    await expect(guest.locator('.watch-volume-slider')).toBeVisible()
    // Guests never get the load/clear UI.
    await expect(guest.getByPlaceholder('Paste a YouTube link or video id')).toHaveCount(0)
    await expect(guest.getByRole('button', { name: 'Clear video' })).toHaveCount(0)

    await guest.close()
    await host.close()
  })

  test('guest without room opt-in does not get play controls', async ({ browser }) => {
    const host = await browser.newPage()
    await stubYouTubeApi(host)

    const password = 'no-guest-ctrl'
    const roomUrl = await createRoom(host, {
      name: `E2E NoGuestCtrl ${Date.now()}`,
      password,
      guestCanControl: false
    })

    await host.getByPlaceholder('Paste a YouTube link or video id').fill('dQw4w9WgXcQ')
    await host.getByRole('button', { name: 'Watch' }).click()
    await expect(host.locator('.watch-play-btn')).toBeVisible()

    const guest = await browser.newPage()
    await stubYouTubeApi(guest)
    await joinAsGuest(guest, roomUrl, { name: 'Guest', password })

    await expect(
      guest.getByText('The host controls playback. Click the video if it falls out of sync.')
    ).toBeVisible({ timeout: 15_000 })
    await expect(guest.locator('.watch-play-btn')).toHaveCount(0)
    // Local volume / hold-to-talk duck still available — per-browser, not a host privilege.
    await expect(guest.locator('.watch-volume-slider')).toBeVisible()
    await expect(guest.getByRole('button', { name: 'Talk' })).toBeVisible()

    await guest.close()
    await host.close()
  })

  test('holding Talk ducks YouTube volume on both browsers', async ({ browser }) => {
    const host = await browser.newPage()
    await stubYouTubeApi(host)

    const password = 'duck-both'
    const roomUrl = await createRoom(host, {
      name: `E2E DuckBoth ${Date.now()}`,
      password,
      guestCanControl: false
    })

    await host.getByPlaceholder('Paste a YouTube link or video id').fill('dQw4w9WgXcQ')
    await host.getByRole('button', { name: 'Watch' }).click()
    await expect(host.getByRole('button', { name: 'Talk' })).toBeVisible()

    const guest = await browser.newPage()
    await stubYouTubeApi(guest)
    await joinAsGuest(guest, roomUrl, { name: 'Guest', password })
    await expect(guest.getByRole('button', { name: 'Talk' })).toBeVisible({ timeout: 15_000 })

    const talkBtn = host.getByRole('button', { name: 'Talk' })
    await talkBtn.hover()
    await host.mouse.down()
    await expect.poll(() => host.evaluate(() => window.__ytVolume)).toBe(25)
    await expect.poll(() => guest.evaluate(() => window.__ytVolume)).toBe(25)
    await host.mouse.up()
    await expect.poll(() => host.evaluate(() => window.__ytVolume)).toBe(100)
    await expect.poll(() => guest.evaluate(() => window.__ytVolume)).toBe(100)

    await guest.close()
    await host.close()
  })
})
