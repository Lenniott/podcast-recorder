import { test, expect } from '@playwright/test'
import {
  stubYouTubeApi,
  createRoom,
  joinAsGuest,
  passRecordingCheck,
  expectCheckQuiet
} from './helpers.js'

test('synced start runs host check then guest check with stay-quiet on the other screen', async ({ browser }) => {
  const host = await browser.newPage()
  await stubYouTubeApi(host)
  const password = 'check-turn'
  const roomUrl = await createRoom(host, { name: `E2E Check Turn ${Date.now()}`, password })

  const guest = await browser.newPage()
  await stubYouTubeApi(guest)
  await joinAsGuest(guest, roomUrl, { name: 'Alex', password })

  await host.getByRole('button', { name: 'Start Recording' }).click()
  await expect(host.getByRole('button', { name: 'Stop Recording' })).toBeVisible()
  await expect(guest.getByRole('button', { name: 'Stop Recording' })).toBeVisible()

  await expect(host.locator('.check-overlay')).toBeVisible()
  await expectCheckQuiet(guest, 'host')
  await expect(host.getByTestId('check-turn')).toHaveAttribute('data-check-turn', 'host')
  await expect(guest.getByTestId('check-turn')).toHaveAttribute('data-check-turn', 'host')
  await expect(host.getByTestId('check-turn')).toHaveAttribute('data-both-turns-passed', 'false')

  await passRecordingCheck(host)
  await expect(guest.locator('.check-overlay')).toBeVisible()
  await expectCheckQuiet(host, 'guest')
  await expect(host.getByTestId('check-turn')).toHaveAttribute('data-check-turn', 'guest')

  await passRecordingCheck(guest)
  await expect(host.getByTestId('check-quiet')).toHaveCount(0)
  await expect(guest.getByTestId('check-quiet')).toHaveCount(0)
  await expect(host.getByTestId('check-turn')).toHaveAttribute('data-both-turns-passed', 'true')
  await expect(guest.getByTestId('check-turn')).toHaveAttribute('data-both-turns-passed', 'true')
  await expect(host.getByTestId('check-turn')).toHaveAttribute('data-check-turn', 'passed')

  await expect(host.getByTestId('take-marker')).toHaveAttribute('data-take-ready', 'false')
  await expect(guest.getByTestId('take-marker')).toHaveAttribute('data-take-ready', 'false')
  await expect(host.getByTestId('take-countdown')).toBeVisible({ timeout: 10_000 })
  await expect(guest.getByTestId('take-countdown')).toBeVisible()
  await expect(host.locator('.clap-flash')).toContainText('from Host', { timeout: 15_000 })
  await expect(guest.locator('.clap-flash')).toContainText('from Host', { timeout: 15_000 })
  await expect(host.getByTestId('take-marker')).toHaveAttribute('data-take-ready', 'true', { timeout: 15_000 })
  await expect(guest.getByTestId('take-marker')).toHaveAttribute('data-take-ready', 'true')
  const hostStart = Number(await host.getByTestId('take-marker').getAttribute('data-take-start-sample'))
  const guestStart = Number(await guest.getByTestId('take-marker').getAttribute('data-take-start-sample'))
  expect(hostStart).toBeGreaterThanOrEqual(0)
  expect(guestStart).toBeGreaterThanOrEqual(0)

  await guest.close()
  await host.close()
})
