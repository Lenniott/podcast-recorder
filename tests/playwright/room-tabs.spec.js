import { test, expect } from '@playwright/test'
import { createRoom, joinAsGuest, stubYouTubeApi } from './helpers.js'

test.describe('Room tabs (shared video + text, symmetric host/guest)', () => {
  test('host and guest land on the same default tab', async ({ browser }) => {
    const host = await browser.newPage()
    await stubYouTubeApi(host)

    const password = 'tabs-default'
    const roomUrl = await createRoom(host, { name: `E2E TabsDefault ${Date.now()}`, password })
    await expect(host.locator('.tab-pill.active')).toContainText('Tab 1')

    const guest = await browser.newPage()
    await stubYouTubeApi(guest)
    await joinAsGuest(guest, roomUrl, { name: 'Guest', password })
    await expect(guest.locator('.tab-pill.active')).toContainText('Tab 1', { timeout: 15_000 })

    await guest.close()
    await host.close()
  })

  test('a guest can add a tab and it becomes the shared active tab for the host too', async ({ browser }) => {
    const host = await browser.newPage()
    await stubYouTubeApi(host)

    const password = 'tabs-create'
    const roomUrl = await createRoom(host, { name: `E2E TabsCreate ${Date.now()}`, password })

    const guest = await browser.newPage()
    await stubYouTubeApi(guest)
    await joinAsGuest(guest, roomUrl, { name: 'Guest', password })

    await guest.getByRole('button', { name: 'Add tab' }).click()

    await expect(guest.locator('.tab-pill.active')).toContainText('Tab 2')
    await expect(host.locator('.tab-pill.active')).toContainText('Tab 2', { timeout: 15_000 })

    await guest.close()
    await host.close()
  })

  test('either peer can load a video into the active tab and both see it — no host gate', async ({ browser }) => {
    const host = await browser.newPage()
    await stubYouTubeApi(host)

    const password = 'tabs-video'
    const roomUrl = await createRoom(host, { name: `E2E TabsVideo ${Date.now()}`, password })

    const guest = await browser.newPage()
    await stubYouTubeApi(guest)
    await joinAsGuest(guest, roomUrl, { name: 'Guest', password })

    // The guest loads the video — symmetric permissions, no host-only gate.
    await guest.getByPlaceholder('Paste a YouTube link or video id').fill('dQw4w9WgXcQ')
    await guest.getByRole('button', { name: 'Watch' }).click()

    await expect(guest.locator('.watch-play-btn')).toBeVisible()
    await expect(host.locator('.watch-play-btn')).toBeVisible({ timeout: 15_000 })

    // The host can control it right back — also symmetric.
    await host.locator('.watch-play-btn').click()
    await expect(host.locator('.watch-play-btn')).toHaveText('⏸ Pause')
    await expect(guest.locator('.watch-play-btn')).toHaveText('⏸ Pause', { timeout: 15_000 })

    await guest.close()
    await host.close()
  })

  test('guest text edits appear in the host\'s shared textarea', async ({ browser }) => {
    const host = await browser.newPage()
    await stubYouTubeApi(host)

    const password = 'tabs-text'
    const roomUrl = await createRoom(host, { name: `E2E TabsText ${Date.now()}`, password })

    const guest = await browser.newPage()
    await stubYouTubeApi(guest)
    await joinAsGuest(guest, roomUrl, { name: 'Guest', password })

    const guestNotes = guest.locator('textarea.shared-textarea')
    await guestNotes.fill('shared notes from guest')

    const hostNotes = host.locator('textarea.shared-textarea')
    await expect(hostNotes).toHaveValue('shared notes from guest', { timeout: 15_000 })

    await guest.close()
    await host.close()
  })

  test('Talk only appears once the active tab\'s video is playing, and ducks volume on both browsers', async ({ browser }) => {
    const host = await browser.newPage()
    await stubYouTubeApi(host)

    const password = 'tabs-talk'
    const roomUrl = await createRoom(host, { name: `E2E TabsTalk ${Date.now()}`, password })

    await host.getByPlaceholder('Paste a YouTube link or video id').fill('dQw4w9WgXcQ')
    await host.getByRole('button', { name: 'Watch' }).click()
    await expect(host.locator('.watch-play-btn')).toBeVisible()

    // Loaded but paused — no Talk button yet.
    await expect(host.getByRole('button', { name: 'Talk' })).toHaveCount(0)

    const guest = await browser.newPage()
    await stubYouTubeApi(guest)
    await joinAsGuest(guest, roomUrl, { name: 'Guest', password })
    await expect(guest.locator('.watch-play-btn')).toBeVisible({ timeout: 15_000 })
    await expect(guest.getByRole('button', { name: 'Talk' })).toHaveCount(0)

    await host.locator('.watch-play-btn').click() // ▶ Play
    const hostTalk = host.getByRole('button', { name: 'Talk' })
    const guestTalk = guest.getByRole('button', { name: 'Talk' })
    await expect(hostTalk).toBeVisible({ timeout: 15_000 })
    await expect(guestTalk).toBeVisible({ timeout: 15_000 })

    await hostTalk.hover()
    await host.mouse.down()
    await expect.poll(() => host.evaluate(() => window.__ytVolume)).toBe(25)
    await expect.poll(() => guest.evaluate(() => window.__ytVolume)).toBe(25)
    await host.mouse.up()
    await expect.poll(() => host.evaluate(() => window.__ytVolume)).toBe(100)
    await expect.poll(() => guest.evaluate(() => window.__ytVolume)).toBe(100)

    await guest.close()
    await host.close()
  })

  test('closing the active tab falls back to another tab for both peers', async ({ browser }) => {
    const host = await browser.newPage()
    await stubYouTubeApi(host)

    const password = 'tabs-close'
    const roomUrl = await createRoom(host, { name: `E2E TabsClose ${Date.now()}`, password })

    const guest = await browser.newPage()
    await stubYouTubeApi(guest)
    await joinAsGuest(guest, roomUrl, { name: 'Guest', password })

    await guest.getByRole('button', { name: 'Add tab' }).click()
    await expect(host.locator('.tab-pill.active')).toContainText('Tab 2', { timeout: 15_000 })

    await guest.getByRole('button', { name: 'Close Tab 2' }).click()
    await expect(guest.locator('.tab-pill.active')).toContainText('Tab 1')
    await expect(host.locator('.tab-pill.active')).toContainText('Tab 1', { timeout: 15_000 })

    await guest.close()
    await host.close()
  })
})
