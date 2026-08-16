import { test, expect } from '@playwright/test'
import { createRoom, stubYouTubeApi } from './helpers.js'

test.describe('Room sidebar collapse', () => {
  test('collapsing hides the full panels but keeps a waveform and the record/clap controls reachable', async ({ browser }) => {
    const page = await browser.newPage()
    await stubYouTubeApi(page)

    const password = 'sidebar-collapse'
    await createRoom(page, { name: `E2E SidebarCollapse ${Date.now()}`, password })

    // Expanded by default: full panels visible.
    await expect(page.locator('#mic-select')).toBeVisible()
    const collapseBtn = page.getByRole('button', { name: 'Collapse sidebar' })
    await expect(collapseBtn).toBeVisible()

    await collapseBtn.click()

    // Room details / mic panel are hidden — that's the point of collapsing.
    await expect(page.locator('#mic-select')).toHaveCount(0)
    // The waveform canvas is never unmounted, just resized.
    await expect(page.locator('.waveform-wrap canvas')).toBeVisible()
    // Record/Stop and Clap stay reachable — same accessible names as expanded.
    const recordBtn = page.getByRole('button', { name: 'Start Recording' })
    const clapBtn = page.getByRole('button', { name: 'Clap' })
    await expect(recordBtn).toBeVisible()
    await expect(clapBtn).toBeVisible()
    await expect(clapBtn).toBeEnabled()

    // Expand again — full panels come back.
    await page.getByRole('button', { name: 'Expand sidebar' }).click()
    await expect(page.locator('#mic-select')).toBeVisible()

    await page.close()
  })
})
