import { test, expect } from '@playwright/test'
import { stubYouTubeApi, createRoom, expandPresenceTable, presenceRow } from './helpers.js'

test('local save failure stops real capture and completes the independent server copy without alerts', async ({ page }) => {
  await stubYouTubeApi(page)
  await page.addInitScript(() => {
    window.__recordingIssues = []
    window.__localWrites = 0
    window.__localClosed = false
    const error = console.error
    console.error = (...args) => {
      if (args[0] === '[recording]') window.__recordingIssues.push(args[1])
      error(...args)
    }
    window.showSaveFilePicker = async () => ({ createWritable: async () => ({
      write: async () => {
        window.__localWrites++
        if (window.__localWrites === 4) throw new Error('test disk failure')
      },
      seek: async () => {},
      close: async () => { window.__localClosed = true }
    }) })
  })
  const alerts = []
  page.on('dialog', async dialog => { alerts.push(dialog.message()); await dialog.dismiss() })
  await createRoom(page, { name: `Recording failure ${Date.now()}`, password: 'failure-test' })
  await expandPresenceTable(page)
  await page.getByRole('button', { name: 'Start Recording' }).click()
  await expect.poll(() => page.evaluate(() => window.__recordingIssues.some(issue => issue.code === 'save-failed'))).toBe(true)
  await expect(page.getByRole('button', { name: 'Start Recording' })).toBeEnabled({ timeout: 20000 })
  await expect(presenceRow(page, 'Host').locator('[data-testid="server-copy-line"]')).toHaveAttribute('data-copy-state', 'complete', { timeout: 20000 })
  expect(await page.evaluate(() => window.__localWrites)).toBe(4)
  expect(await page.evaluate(() => window.__localClosed)).toBe(false)
  expect(alerts).toEqual([])
})

test('permanent server failure stops capture and closes the local file without alerts', async ({ page }) => {
  await stubYouTubeApi(page)
  await page.addInitScript(() => {
    window.__recordingIssues = []
    window.__localClosed = false
    window.__savedBytes = 0
    const error = console.error
    console.error = (...args) => {
      if (args[0] === '[recording]') window.__recordingIssues.push(args[1])
      error(...args)
    }
    window.showSaveFilePicker = async () => ({ createWritable: async () => ({
      write: async buffer => { window.__savedBytes += buffer.byteLength },
      seek: async () => {},
      close: async () => { window.__localClosed = true }
    }) })
  })
  await page.route('**/server-copy/chunks*', route => route.fulfill({ status: 410, body: '{}' }))
  const alerts = []
  page.on('dialog', async dialog => { alerts.push(dialog.message()); await dialog.dismiss() })
  await createRoom(page, { name: `Server failure ${Date.now()}`, password: 'failure-test' })
  await page.getByRole('button', { name: 'Start Recording' }).click()
  await expect.poll(() => page.evaluate(() => window.__recordingIssues)).toEqual(expect.arrayContaining([expect.objectContaining({ destination: 'server', code: 'save-failed' })]))
  await expect(page.getByRole('button', { name: 'Start Recording' })).toBeEnabled({ timeout: 20000 })
  expect(await page.evaluate(() => window.__localClosed)).toBe(true)
  expect(await page.evaluate(() => window.__savedBytes)).toBeGreaterThan(88)
  expect(alerts).toEqual([])
})
