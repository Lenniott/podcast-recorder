import { test, expect } from '@playwright/test'
import { stubYouTubeApi, createRoom, joinAsGuest, trackLiveSockets, closeLiveSockets, expandPresenceTable, presenceRow } from './helpers.js'

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
  await expect(guest.getByRole('button', { name: 'Request to stop recording' })).toBeVisible()
  await expect(guest.getByTestId('peer-recording')).toBeVisible()
  await expandPresenceTable(host)
  await expect(presenceRow(host, 'Host')).toHaveAttribute('data-recording', 'true')
  await expect(presenceRow(host, 'Alex')).toHaveAttribute('data-recording', 'true')

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
  await expect(guest.getByRole('button', { name: 'Request to stop recording' })).toBeVisible()
  await expect(guest.getByTestId('peer-recording')).toBeVisible()

  await closeLiveSockets(host)
  await expect(guest.getByTestId('peer-recording')).toBeVisible({ timeout: 15_000 })

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
  await expect(page.getByRole('button', { name: 'New room' })).toBeVisible()
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

test('closing the tab during a recording asks the browser to confirm', async ({ page }) => {
  await stubYouTubeApi(page)
  const password = 'rec-close-tab'
  await createRoom(page, { name: `E2E Rec Close Tab ${Date.now()}`, password })

  await expect(page.getByRole('button', { name: 'Start Recording' })).toBeEnabled()
  await page.getByRole('button', { name: 'Start Recording' }).click()
  await expect(page.getByRole('button', { name: 'Stop Recording' })).toBeVisible()

  const dialog = page.waitForEvent('dialog')
  await page.close({ runBeforeUnload: true })
  const shown = await dialog
  expect(shown.type()).toBe('beforeunload')
  await shown.dismiss()
  expect(page.isClosed()).toBe(false)
})

// The guest is the fixture page: a page opened with browser.newPage() closes
// without surfacing a beforeunload dialog here, even when its handler blocks.
test('a guest whose recording the host started is warned before closing the tab', async ({ browser, page: guest }) => {
  const host = await browser.newPage()
  await stubYouTubeApi(host)
  const password = 'rec-guest-close'
  const roomUrl = await createRoom(host, { name: `E2E Rec Guest Close ${Date.now()}`, password })

  await stubYouTubeApi(guest)
  await joinAsGuest(guest, roomUrl, { name: 'Alex', password })

  await expect(host.getByRole('button', { name: 'Start Recording' })).toBeEnabled()
  await host.getByRole('button', { name: 'Start Recording' }).click()
  await expect(guest.getByRole('button', { name: 'Request to stop recording' })).toBeVisible()
  await expect(guest.locator('.stats-bar .recording-stat')).toBeVisible()

  const dialog = guest.waitForEvent('dialog')
  await guest.close({ runBeforeUnload: true })
  const shown = await dialog
  expect(shown.type()).toBe('beforeunload')
  await shown.dismiss()
  expect(guest.isClosed()).toBe(false)

  await guest.close()
  await host.close()
})
