import { test, expect } from '@playwright/test'
import { fillField, openCreateRoom, stubYouTubeApi, unlockIfNeeded } from './helpers.js'

async function openMicStep(page) {
  await stubYouTubeApi(page)
  await page.goto('/')
  await unlockIfNeeded(page)
  await openCreateRoom(page)
  await fillField(page.locator('#room-episode-name'), `E2E MobileNote ${Date.now()}`)
  await fillField(page.locator('#room-episode-code'), 'mobile-note')
  await Promise.all([
    page.waitForURL(/\/rec\//, { timeout: 30_000 }),
    page.getByRole('button', { name: /Create Room/i }).click()
  ])
  await fillField(page.getByLabel('Your name'), 'Host')
  await page.getByRole('button', { name: /Continue/i }).click()
  await expect(page.getByRole('heading', { name: 'Microphone' })).toBeVisible()
}

test('desktop mic step does not show the phone recording note', async ({ page }) => {
  await openMicStep(page)
  await expect(page.getByTestId('mobile-recording-note')).toBeHidden()
})

test.describe('on a touch phone', () => {
  test.use({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true })

  test('mic step tells the guest to stay on the tab and call from another device', async ({ page }) => {
    await openMicStep(page)
    const note = page.getByTestId('mobile-recording-note')
    await expect(note).toBeVisible()
    await expect(note).toContainText('Keep this tab open and on screen')
    await expect(note).toContainText('on a different device')
  })
})
