import { test, expect } from '@playwright/test'
import {
  stubYouTubeApi,
  createRoom,
  fillField,
  openCreateRoom,
  unlockIfNeeded,
  joinAsGuest,
  passRecordingCheck
} from './helpers.js'

const localCopyFiles = (page) => page.evaluate(() => window.__prLocalCopyFiles)
const localCopyRequests = (page) => page.evaluate(() => window.__prLocalCopyRequests)
const directoryPickerCalls = (page) => page.evaluate(() => window.__prDirectoryPickerCalls)

async function rejectRecordingCheck(page) {
  const overlay = page.locator('.check-overlay')
  await expect(overlay).toBeVisible()
  const listenBtn = page.getByRole('button', { name: /Listen back/ })
  const rejectBtn = page.getByRole('button', { name: /Something.s wrong/ })
  await expect(async () => {
    await listenBtn.click()
    await expect(rejectBtn).toBeVisible({ timeout: 500 })
  }).toPass({ timeout: 10_000 })
  await rejectBtn.click()
}

async function createRoomThroughExplainer(page, name) {
  await page.goto('/')
  await unlockIfNeeded(page)
  await openCreateRoom(page)
  await fillField(page.locator('#room-episode-name'), name)
  await fillField(page.locator('#room-episode-code'), 'join-save')
  await Promise.all([
    page.waitForURL(/\/rec\//, { timeout: 30_000 }),
    page.getByRole('button', { name: /Create Room/i }).click()
  ])

  await fillField(page.getByLabel('Your name'), 'Host')
  await page.getByRole('button', { name: /Continue/i }).click()

  await expect(page.getByRole('heading', { name: 'Local Copy' })).toBeVisible()
  await expect(page.locator('#mic-select')).toHaveCount(0)
  await expect(page.getByRole('button', { name: 'Start Recording' })).toHaveCount(0)
}

test('host join: Local Copy explainer, save once, mic, then Start Recording does not prompt again', async ({ page }) => {
  await stubYouTubeApi(page)
  await createRoomThroughExplainer(page, `E2E JoinSave ${Date.now()}`)

  await expect(page.getByText('Your audio is also recorded on this device, as insurance if our end drops out.')).toBeVisible()
  await expect(page.getByText('The host normally uses the automatic server copy. You will not normally need to send us this file.')).toBeVisible()

  await page.getByRole('button', { name: 'Choose save location' }).click()

  await expect(page.getByRole('heading', { name: 'Microphone' })).toBeVisible()
  await expect(page.locator('#mic-select')).toBeVisible()
  await expect(page.getByRole('heading', { name: 'Local Copy' })).toHaveCount(0)

  await page.getByRole('button', { name: 'Continue to room' }).click()

  await expect(page.getByRole('button', { name: 'Start Recording' })).toBeVisible()
  await expect(page.getByRole('button', { name: 'Tab 1' })).toBeVisible()
  expect(await directoryPickerCalls(page)).toBe(1)
  expect(await localCopyFiles(page)).toEqual([])

  await page.getByRole('button', { name: 'Start Recording' }).click()
  await expect(page.getByRole('button', { name: 'Stop Recording' })).toBeVisible()
  expect(await directoryPickerCalls(page)).toBe(1)
  const files = await localCopyFiles(page)
  expect(files).toHaveLength(1)
  expect(files[0]).toMatch(/^host-e2e-joinsave-\d+-\d{4}-\d{2}-\d{2}-take-1\.wav$/)
})

test('host reject mid-check: next attempt opens take-2 in the same folder, no Start click, no second picker', async ({ page }) => {
  await stubYouTubeApi(page)
  await createRoomThroughExplainer(page, 'E2E Retake')
  await page.getByRole('button', { name: 'Choose save location' }).click()
  await expect(page.locator('#mic-select')).toBeVisible()
  await page.getByRole('button', { name: 'Continue to room' }).click()

  await page.getByRole('button', { name: 'Start Recording' }).click()
  await expect(page.getByRole('button', { name: 'Stop Recording' })).toBeVisible()
  await expect.poll(() => localCopyFiles(page)).toHaveLength(1)
  const [firstName] = await localCopyFiles(page)
  expect(firstName).toMatch(/^host-e2e-retake-\d{4}-\d{2}-\d{2}-take-1\.wav$/)
  const requestsBeforeReject = (await localCopyRequests(page)).length

  await rejectRecordingCheck(page)

  await expect.poll(() => localCopyFiles(page)).toHaveLength(2)
  const [, secondName] = await localCopyFiles(page)
  expect(secondName).toBe(firstName.replace('-take-1.wav', '-take-2.wav'))
  expect((await localCopyRequests(page)).slice(requestsBeforeReject)).not.toContain(firstName)
  expect(await directoryPickerCalls(page)).toBe(1)

  // The check restarted on the new file without another Start click.
  await expect(page.getByRole('button', { name: 'Stop Recording' })).toBeVisible()
  await expect(page.locator('.check-overlay')).toBeVisible()
  await passRecordingCheck(page)
  expect(await localCopyFiles(page)).toHaveLength(2)
})

test('guest join: same Local Copy then mic sequence, one picker only', async ({ browser }) => {
  const host = await browser.newPage()
  await stubYouTubeApi(host)
  const password = 'join-save-guest'
  const roomUrl = await createRoom(host, { name: `E2E JoinSaveGuest ${Date.now()}`, password })

  const guest = await browser.newPage()
  await stubYouTubeApi(guest)
  await guest.goto(roomUrl)
  await fillField(guest.getByLabel('Your name'), 'Guest')
  await fillField(guest.locator('#room-episode-code'), password)
  await guest.getByRole('button', { name: /Join Room/i }).click()

  await expect(guest.getByRole('heading', { name: 'Local Copy' })).toBeVisible()
  await expect(guest.locator('#mic-select')).toHaveCount(0)
  await guest.getByRole('button', { name: 'Choose save location' }).click()
  await expect(guest.locator('#mic-select')).toBeVisible()
  await guest.getByRole('button', { name: 'Continue to room' }).click()

  await expect(guest.getByRole('button', { name: 'Start Recording' })).toBeVisible()
  expect(await directoryPickerCalls(guest)).toBe(1)

  await guest.getByRole('button', { name: 'Start Recording' }).click()
  await expect(guest.getByRole('button', { name: 'Stop Recording' })).toBeVisible()
  expect(await directoryPickerCalls(guest)).toBe(1)

  await guest.close()
  await host.close()
})

test('synced guest reject: both browsers roll to their own take-2 and the check restarts on the host turn', async ({ browser }) => {
  const host = await browser.newPage()
  await stubYouTubeApi(host)
  const password = 'join-save-retake'
  const roomUrl = await createRoom(host, { name: 'E2E Synced Retake', password })

  const guest = await browser.newPage()
  await stubYouTubeApi(guest)
  await joinAsGuest(guest, roomUrl, { name: 'Alex', password })

  await host.getByRole('button', { name: 'Start Recording' }).click()
  await expect(guest.getByRole('button', { name: 'Stop Recording' })).toBeVisible()
  await expect.poll(() => localCopyFiles(host)).toHaveLength(1)
  await expect.poll(() => localCopyFiles(guest)).toHaveLength(1)

  await passRecordingCheck(host)
  await rejectRecordingCheck(guest)

  await expect.poll(() => localCopyFiles(guest)).toHaveLength(2)
  await expect.poll(() => localCopyFiles(host)).toHaveLength(2)
  const guestFiles = await localCopyFiles(guest)
  const hostFiles = await localCopyFiles(host)
  expect(guestFiles[0]).toMatch(/^alex-e2e-synced-retake-\d{4}-\d{2}-\d{2}-take-1\.wav$/)
  expect(guestFiles[1]).toBe(guestFiles[0].replace('-take-1.wav', '-take-2.wav'))
  expect(hostFiles[0]).toMatch(/^host-e2e-synced-retake-\d{4}-\d{2}-\d{2}-take-1\.wav$/)
  expect(hostFiles[1]).toBe(hostFiles[0].replace('-take-1.wav', '-take-2.wav'))
  expect(await directoryPickerCalls(host)).toBe(1)
  expect(await directoryPickerCalls(guest)).toBe(1)

  await expect(host.locator('.check-overlay')).toBeVisible()
  await expect(guest.getByTestId('check-quiet')).toBeVisible()
  await expect(host.getByRole('button', { name: 'Stop Recording' })).toBeVisible()
  await expect(guest.getByRole('button', { name: 'Stop Recording' })).toBeVisible()

  await guest.close()
  await host.close()
})
