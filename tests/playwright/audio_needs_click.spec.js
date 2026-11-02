import { test, expect } from '@playwright/test'
import { createRoom, stubYouTubeApi } from './helpers.js'

/**
 * Safari (and DuckDuckGo on Mac) keep an AudioContext suspended, with
 * resume() left pending, until a click on the page. Playwright's browsers
 * lift that rule, so reproduce it: every context starts suspended and
 * resume() only goes through once a click has happened.
 */
async function audioNeedsClick(page) {
  await page.addInitScript(() => {
    let clicked = false
    const waiters = []
    document.addEventListener('click', () => {
      clicked = true
      while (waiters.length) waiters.shift()()
    }, { capture: true })
    const Native = window.AudioContext
    window.AudioContext = class extends Native {
      constructor(options) {
        super(options)
        if (!clicked) void super.suspend()
      }
      resume() {
        if (clicked) return super.resume()
        return new Promise((resolve) => waiters.push(resolve)).then(() => super.resume())
      }
    }
  })
}

const roomReady = (page) => page.locator('.room-tabs[data-ws-ready="true"]')

test('the room connects even while audio waits for a click, and a refresh skips the mic step', async ({ page }) => {
  await audioNeedsClick(page)
  await stubYouTubeApi(page)
  await createRoom(page, { name: `E2E AudioClick ${Date.now()}`, password: 'audio-click' })

  // Continue on the mic step is the click that lets audio run.
  await expect(roomReady(page)).toBeAttached({ timeout: 30_000 })
  await expect(page.getByTestId('audio-paused')).toHaveCount(0)

  await page.reload()

  // Straight back into the room: connected, with tabs, no mic step.
  await expect(roomReady(page)).toBeAttached({ timeout: 30_000 })
  await expect(page.getByRole('button', { name: 'Continue to room' })).toHaveCount(0)

  // No click yet, so the mic is not being captured, and the room says so.
  const paused = page.getByTestId('audio-paused')
  await expect(paused).toBeVisible()
  await paused.getByRole('button', { name: 'Turn mic back on' }).click()
  await expect(paused).toHaveCount(0)
})
