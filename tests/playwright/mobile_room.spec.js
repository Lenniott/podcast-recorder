import { test, expect } from '@playwright/test'
import { stubYouTubeApi, createRoom, joinAsGuest, presenceRow } from './helpers.js'

test.use({ viewport: { width: 390, height: 844 } })

test('narrow room shows one region at a time with record controls always reachable', async ({ browser }) => {
  const host = await browser.newPage({ viewport: { width: 390, height: 844 } })
  await stubYouTubeApi(host)
  const password = 'mobile-room'
  const roomUrl = await createRoom(host, { name: `E2E Mobile ${Date.now()}`, password, hostDisplayName: 'Host' })
  const checkOverlay = host.getByRole('dialog', { name: 'Test your microphone?' })
  if (await checkOverlay.isVisible()) {
    await host.getByRole('button', { name: 'Skip microphone check' }).click()
    await expect(checkOverlay).toBeHidden()
  }

  // Header starts compact: live waveform and record/clap, mic picker folded away.
  await expect(host.getByTestId('live-waveform')).toBeVisible()
  await expect(host.getByRole('button', { name: 'Start Recording' })).toBeVisible()
  await expect(host.getByRole('button', { name: 'Clap' })).toBeVisible()
  await expect(host.getByRole('combobox', { name: 'Mic' })).toHaveCount(0)

  await host.getByRole('button', { name: 'Show recording controls' }).click()
  await expect(host.getByRole('combobox', { name: 'Mic' })).toBeVisible()
  await host.getByRole('button', { name: 'Hide recording controls' }).click()
  await expect(host.getByRole('combobox', { name: 'Mic' })).toHaveCount(0)

  // Tabs is the default region; research and participants are hidden but mounted.
  await expect(host.getByRole('tab', { name: 'Tabs' })).toHaveAttribute('aria-selected', 'true')
  await expect(host.getByTestId('research-panel')).toBeHidden()
  await expect(host.getByTestId('research-panel')).toHaveCount(1)

  await host.getByRole('tab', { name: 'Research' }).click()
  await expect(host.getByTestId('research-panel')).toBeVisible()
  await expect(host.getByRole('button', { name: 'Collapse Research Assistant' })).toBeHidden()

  const guest = await browser.newPage({ viewport: { width: 390, height: 844 } })
  await stubYouTubeApi(guest)
  await joinAsGuest(guest, roomUrl, { name: 'Alex', password })

  await host.getByRole('tab', { name: 'Participants' }).click()
  await expect(host.getByTestId('research-panel')).toBeHidden()
  await expect(host.getByTestId('presence-fold')).toHaveCount(0)
  const row = presenceRow(host, 'Alex')
  await expect(row).toBeVisible({ timeout: 15_000 })
  await expect(row.locator('.pill-guest')).toBeVisible()
  const box = await row.boundingBox()
  expect(box.width).toBeLessThanOrEqual(390)

  await guest.close()
  await host.close()
})
