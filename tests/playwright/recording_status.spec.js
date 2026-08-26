import { test, expect } from '@playwright/test'
import { stubYouTubeApi, createRoom, joinAsGuest, trackLiveSockets, closeLiveSockets } from './helpers.js'

test('starting recording flips this peer to Recording on both browsers', async ({ browser }) => {
  const host = await browser.newPage()
  await stubYouTubeApi(host)
  const password = 'rec-status'
  const roomUrl = await createRoom(host, { name: `E2E Rec ${Date.now()}`, password })

  const guest = await browser.newPage()
  await stubYouTubeApi(guest)
  await joinAsGuest(guest, roomUrl, { name: 'Alex', password })

  await expect(host.getByRole('button', { name: 'Start Recording' })).toBeEnabled()
  await host.getByRole('button', { name: 'Start Recording' }).click()
  await expect(host.getByRole('button', { name: 'Stop Recording' })).toBeVisible()
  await expect(host.locator('.peer', { hasText: 'Host' }).locator('.pill-recording')).toBeVisible()
  await expect(guest.locator('.peer', { hasText: 'Host' }).locator('.pill-recording')).toBeVisible()

  await guest.close()
  await host.close()
})

test('recording pill survives a mid-take socket close and reconnect', async ({ browser }) => {
  const host = await browser.newPage()
  await trackLiveSockets(host)
  await stubYouTubeApi(host)
  const password = 'rec-resync'
  const roomUrl = await createRoom(host, { name: `E2E Rec Resync ${Date.now()}`, password })

  const guest = await browser.newPage()
  await stubYouTubeApi(guest)
  await joinAsGuest(guest, roomUrl, { name: 'Alex', password })

  await expect(host.getByRole('button', { name: 'Start Recording' })).toBeEnabled()
  await host.getByRole('button', { name: 'Start Recording' }).click()
  await expect(host.getByRole('button', { name: 'Stop Recording' })).toBeVisible()
  const hostPill = guest.locator('.peer', { hasText: 'Host' }).locator('.pill-recording')
  await expect(hostPill).toBeVisible()

  await closeLiveSockets(host)
  await expect(hostPill).toBeVisible({ timeout: 15_000 })

  await guest.close()
  await host.close()
})

test('active local recording warns before leaving the room', async ({ page }) => {
  await stubYouTubeApi(page)
  const password = 'rec-leave'
  const roomUrl = await createRoom(page, { name: `E2E Rec Leave ${Date.now()}`, password })

  await expect(page.getByRole('button', { name: 'Start Recording' })).toBeEnabled()
  await page.getByRole('button', { name: 'Start Recording' }).click()
  await expect(page.getByRole('button', { name: 'Stop Recording' })).toBeVisible()

  let sawBeforeUnload = false
  page.once('dialog', async (dialog) => {
    sawBeforeUnload = dialog.type() === 'beforeunload'
    await dialog.dismiss()
  })

  await page.goto('/').catch(() => {})

  expect(sawBeforeUnload).toBe(true)
  await expect(page).toHaveURL(roomUrl)
})

test('idle local recording leaves the room without a warning', async ({ page }) => {
  await stubYouTubeApi(page)
  const password = 'rec-idle-leave'
  await createRoom(page, { name: `E2E Rec Idle Leave ${Date.now()}`, password })

  let dialogCount = 0
  page.on('dialog', async (dialog) => {
    dialogCount += 1
    await dialog.dismiss()
  })

  await page.goto('/')

  expect(dialogCount).toBe(0)
  await expect(page.getByRole('button', { name: /Create Room/i })).toBeVisible()
})

test('active local recording warns before in-app navigation', async ({ page }) => {
  await stubYouTubeApi(page)
  const password = 'rec-spa-leave'
  const roomUrl = await createRoom(page, { name: `E2E Rec SPA Leave ${Date.now()}`, password })

  await expect(page.getByRole('button', { name: 'Start Recording' })).toBeEnabled()
  await page.getByRole('button', { name: 'Start Recording' }).click()
  await expect(page.getByRole('button', { name: 'Stop Recording' })).toBeVisible()

  await page.evaluate(() => {
    const link = document.createElement('a')
    link.href = '/'
    link.textContent = 'Leave room'
    link.dataset.testid = 'leave-room-link'
    link.style.position = 'fixed'
    link.style.top = '8px'
    link.style.left = '8px'
    link.style.zIndex = '2000'
    document.body.appendChild(link)
  })

  let message = ''
  page.once('dialog', async (dialog) => {
    message = dialog.message()
    await dialog.dismiss()
  })

  await page.getByTestId('leave-room-link').click()

  expect(message).toContain('Your local recording is still in progress')
  expect(message).toContain('WAV is finalized')
  expect(message).not.toContain('server copy')
  await expect(page).toHaveURL(roomUrl)
})
