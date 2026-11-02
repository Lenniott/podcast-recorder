import { test, expect } from '@playwright/test'
import { readFileSync } from 'node:fs'
import {
  stubYouTubeApi,
  createRoom,
  fillField,
  openCreateRoom,
  unlockIfNeeded,
  joinAsGuest,
  passRecordingCheck,
  stopAsHost,
  closeSavePrompt,
  localCopyFiles,
  roomTabsReady
} from './helpers.js'

async function rejectRecordingCheck(page) {
  const overlay = page.getByRole('dialog', { name: 'Test your microphone?' })
  await expect(overlay).toBeVisible()
  const listenBtn = page.getByRole('button', { name: /Listen back/ })
  const rejectBtn = page.getByRole('button', { name: /Something.s wrong/ })
  await expect(async () => {
    await listenBtn.click()
    await expect(rejectBtn).toBeVisible({ timeout: 500 })
  }).toPass({ timeout: 10_000 })
  await rejectBtn.click()
}

async function localCopyAudio(page, name) {
  return page.evaluate(async name => {
    const root = await navigator.storage.getDirectory()
    const base = await root.getDirectoryHandle('local-copy')
    const room = await base.getDirectoryHandle(location.pathname.split('/').pop())
    const file = await (await room.getFileHandle(name)).getFile()
    return Array.from(new Uint8Array(await file.slice(44).arrayBuffer()))
  }, name)
}

function readWav(path) {
  const bytes = readFileSync(path)
  return {
    riff: bytes.toString('ascii', 0, 4),
    wave: bytes.toString('ascii', 8, 12),
    riffSize: bytes.readUInt32LE(4),
    dataBytes: bytes.readUInt32LE(40),
    size: bytes.byteLength
  }
}

test('host join goes from name straight to the mic, and Start writes take-1 into this browser', async ({ page }) => {
  await stubYouTubeApi(page)
  const name = `E2E LocalCopy ${Date.now()}`
  await page.goto('/')
  await unlockIfNeeded(page)
  await openCreateRoom(page)
  await fillField(page.locator('#room-episode-name'), name)
  await fillField(page.locator('#room-episode-code'), 'local-copy')
  await Promise.all([
    page.waitForURL(/\/rec\//, { timeout: 30_000 }),
    page.getByRole('button', { name: /Create Room/i }).click()
  ])
  await fillField(page.getByLabel('Your name'), 'Host')
  await page.getByRole('button', { name: /Continue/i }).click()

  await expect(page.getByRole('heading', { name: 'Microphone' })).toBeVisible()
  await expect(page.getByRole('heading', { name: 'Local Copy' })).toHaveCount(0)
  await page.getByRole('button', { name: 'Continue to room' }).click()
  await expect(page.getByRole('button', { name: 'Start Recording' })).toBeVisible()
  expect(await localCopyFiles(page)).toEqual([])

  await page.getByRole('button', { name: 'Start Recording' }).click()
  await expect(page.getByRole('button', { name: 'Stop Recording' })).toBeVisible()
  await expect.poll(() => localCopyFiles(page)).toHaveLength(1)
  const [file] = await localCopyFiles(page)
  expect(file).toMatch(/^host-e2e-localcopy-\d+-\d{4}-\d{2}-\d{2}-take-1\.wav$/)
})

test('a real stop asks to save, and Save downloads a complete WAV of the take', async ({ page }) => {
  await stubYouTubeApi(page)
  await createRoom(page, { name: `E2E Save ${Date.now()}`, password: 'local-copy-save' })

  await page.getByRole('button', { name: 'Start Recording' }).click()
  await passRecordingCheck(page)
  await page.waitForTimeout(2000)
  await stopAsHost(page)

  const prompt = page.getByTestId('local-copy-save-prompt')
  await expect(prompt).toBeVisible({ timeout: 20_000 })
  await expect(prompt).toContainText(/Length \d{2}:\d{2}/)
  await expect(prompt).not.toContainText('Ended early')

  const [download] = await Promise.all([
    page.waitForEvent('download'),
    prompt.getByRole('link', { name: 'Save recording' }).click()
  ])
  expect(download.suggestedFilename()).toMatch(/^host-e2e-save-\d+-\d{4}-\d{2}-\d{2}-take-1\.wav$/)
  const wav = readWav(await download.path())
  expect(wav.riff).toBe('RIFF')
  expect(wav.wave).toBe('WAVE')
  expect(wav.dataBytes).toBe(wav.size - 44)
  expect(wav.riffSize).toBe(wav.size - 8)
  // A couple of seconds of 48 kHz 16-bit mono, not just a header.
  expect(wav.dataBytes).toBeGreaterThan(100_000)
  await expect(prompt).toBeHidden()

  // Saving never deletes; the take stays until they confirm Remove.
  const row = page.getByTestId('local-copy-row')
  await expect(row).toHaveCount(1)
  await expect(row).toContainText('Saved')
  expect(await localCopyFiles(page)).toHaveLength(1)

  page.once('dialog', (dialog) => dialog.dismiss())
  await row.getByRole('button', { name: /Remove Take 1/ }).click()
  await expect(row).toHaveCount(1)
  expect(await localCopyFiles(page)).toHaveLength(1)

  page.once('dialog', (dialog) => {
    expect(dialog.message()).toContain('once the saved file opens')
    dialog.accept()
  })
  await row.getByRole('button', { name: /Remove Take 1/ }).click()
  await expect(row).toHaveCount(0)
  expect(await localCopyFiles(page)).toEqual([])
})

test('an unsaved take survives a refresh and is listed again with its length', async ({ page }) => {
  await stubYouTubeApi(page)
  await createRoom(page, { name: `E2E Refresh ${Date.now()}`, password: 'local-copy-refresh' })

  await page.getByRole('button', { name: 'Start Recording' }).click()
  await passRecordingCheck(page)
  await page.waitForTimeout(1500)
  await stopAsHost(page)
  await closeSavePrompt(page)
  const list = page.getByTestId('local-copy-list')
  await expect(list.getByTestId('local-copy-row')).toHaveCount(1)

  await page.reload()
  await roomTabsReady(page)

  const rows = page.getByTestId('local-copy-list').getByTestId('local-copy-row')
  await expect(rows).toHaveCount(1)
  await expect(rows.first()).toContainText('Take 1')
  await expect(rows.first()).toContainText(/\d{2}:\d{2}/)
  await expect(rows.first().getByRole('link', { name: 'Save' })).toBeVisible()
  await expect(page.getByTestId('local-copy-save-prompt')).toHaveCount(0)
})

test('host reject mid-check: take-2 opens without a Start click, take-1 is listed, and nothing asks to save', async ({ page }) => {
  await stubYouTubeApi(page)
  await createRoom(page, { name: 'E2E Retake', password: 'local-copy-retake' })

  await page.getByRole('button', { name: 'Start Recording' }).click()
  await expect(page.getByRole('button', { name: 'Stop Recording' })).toBeVisible()
  await expect.poll(() => localCopyFiles(page)).toHaveLength(1)
  const [firstName] = await localCopyFiles(page)
  expect(firstName).toMatch(/^host-e2e-retake-\d{4}-\d{2}-\d{2}-take-1\.wav$/)

  await expect(async () => {
    await page.getByRole('button', { name: 'Listen back' }).click()
    await expect(page.getByRole('button', { name: 'Yes, continue' })).toBeVisible({ timeout: 500 })
  }).toPass()
  const originalAudio = await localCopyAudio(page, firstName)
  expect(originalAudio.length).toBeGreaterThan(0)
  await rejectRecordingCheck(page)

  await expect.poll(() => localCopyFiles(page)).toHaveLength(2)
  const [, secondName] = await localCopyFiles(page)
  expect(secondName).toBe(firstName.replace('-take-1.wav', '-take-2.wav'))

  const retainedAudio = await localCopyAudio(page, firstName)
  expect(retainedAudio.slice(0, originalAudio.length)).toEqual(originalAudio)

  // The check restarted on the new file without another Start click.
  await expect(page.getByRole('button', { name: 'Stop Recording' })).toBeVisible()
  await expect(page.getByRole('dialog', { name: 'Test your microphone?' })).toBeVisible()
  await expect(page.locator(`[data-testid="local-copy-row"][data-name="${firstName}"]`)).toBeAttached()
  await expect(page.locator(`[data-testid="local-copy-row"][data-name="${secondName}"]`)).toHaveCount(0)
  await expect(page.getByTestId('local-copy-save-prompt')).toHaveCount(0)
  await passRecordingCheck(page)
  expect(await localCopyFiles(page)).toHaveLength(2)
})

test('guest join: mic then room, and Start writes the guest\'s own take-1', async ({ browser }) => {
  const host = await browser.newPage()
  await stubYouTubeApi(host)
  const password = 'local-copy-guest'
  const roomUrl = await createRoom(host, { name: `E2E LocalCopyGuest ${Date.now()}`, password })

  const guest = await browser.newPage()
  await stubYouTubeApi(guest)
  await guest.goto(roomUrl)
  await fillField(guest.getByLabel('Your name'), 'Guest')
  await fillField(guest.locator('#room-episode-code'), password)
  // A click before hydration does nothing; retry until the mic step shows.
  await expect(async () => {
    await guest.getByRole('button', { name: /Join Room/i }).click()
    await expect(guest.locator('#mic-select')).toBeVisible({ timeout: 3_000 })
  }).toPass({ timeout: 30_000 })
  await guest.getByRole('button', { name: 'Continue to room' }).click()

  // Host gone → guest Start is solo (no ask). Host still present would pipe the ask.
  await host.close()
  await expect(guest.getByText('Waiting for guest…').first()).toBeVisible({ timeout: 15_000 })

  await expect(guest.getByRole('button', { name: 'Start Recording' })).toBeVisible()
  await guest.getByRole('button', { name: 'Start Recording' }).click()
  await expect(guest.getByRole('button', { name: 'Request to start recording' })).toHaveCount(0)
  await expect(guest.getByRole('button', { name: 'Stop Recording' })).toBeVisible()
  await expect.poll(() => localCopyFiles(guest)).toEqual([expect.stringMatching(/^guest-.*-take-1\.wav$/)])

  await guest.close()
})

test('synced guest reject: both browsers roll to their own take-2 and the check restarts on the host turn', async ({ browser }) => {
  const host = await browser.newPage()
  await stubYouTubeApi(host)
  const password = 'local-copy-synced'
  const roomUrl = await createRoom(host, { name: 'E2E Synced Retake', password })

  const guest = await browser.newPage()
  await stubYouTubeApi(guest)
  await joinAsGuest(guest, roomUrl, { name: 'Alex', password })

  await host.getByRole('button', { name: 'Start Recording' }).click()
  await expect(guest.getByRole('button', { name: 'Request to stop recording' })).toBeVisible()
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

  await expect(host.getByRole('dialog', { name: 'Test your microphone?' })).toBeVisible()
  await expect(guest.getByTestId('check-quiet')).toBeVisible()
  await expect(host.getByRole('button', { name: 'Stop Recording' })).toBeVisible()
  await expect(guest.getByRole('button', { name: 'Request to stop recording' })).toBeVisible()

  await guest.close()
  await host.close()
})
