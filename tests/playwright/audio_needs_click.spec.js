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

test('Continue paints its loading state before waking Safari audio', async ({ page }) => {
  await stubYouTubeApi(page)
  await createRoom(page, { name: `E2E ContinuePaint ${Date.now()}`, password: 'paint' })
  await audioNeedsClick(page)
  await page.addInitScript(() => {
    for (const key of Object.keys(sessionStorage)) {
      if (key.startsWith('pr_mic_confirmed_')) sessionStorage.removeItem(key)
    }
    window.continueAudioStates = []
    let continuing = false
    document.addEventListener('click', event => {
      if (event.target.closest('button')?.textContent.trim() === 'Continue to room') continuing = true
    }, { capture: true })
    const Native = window.AudioContext
    window.AudioContext = class extends Native {
      resume() {
        // Hold the initial request so the click must explicitly wake audio.
        if (!continuing) return new Promise(() => {})
        if (continuing) {
          const button = document.querySelector('.gate-card button.btn-block')
          window.continueAudioStates.push(button?.disabled && button.textContent.trim() === 'Loading room...')
        }
        return super.resume()
      }
    }
  })
  await page.reload()
  await expect(page.locator('#mic-select')).toHaveAttribute('aria-busy', 'false')
  await page.getByRole('button', { name: 'Continue to room' }).click()
  await expect(roomReady(page)).toBeAttached()
  const states = await page.evaluate(() => window.continueAudioStates)
  expect(states.length).toBeGreaterThan(0)
  expect(states.every(Boolean)).toBe(true)
})

for (const pending of ['permission', 'audio setup']) {
  test(`Continue connects the room while microphone ${pending} is still pending`, async ({ page }) => {
    await stubYouTubeApi(page)
    await createRoom(page, { name: `E2E SlowMic ${Date.now()}`, password: 'slow-mic' })
    await page.addInitScript(pending => {
      for (const key of Object.keys(sessionStorage)) {
        if (key.startsWith('pr_mic_confirmed_')) sessionStorage.removeItem(key)
      }
      if (pending === 'permission') {
        const native = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices)
        let first = true
        navigator.mediaDevices.getUserMedia = async constraints => {
          if (first) {
            first = false
            await new Promise(resolve => { window.releaseMicrophone = resolve })
          }
          return native(constraints)
        }
      } else {
        const native = Worklet.prototype.addModule
        Worklet.prototype.addModule = async function (...args) {
          await new Promise(resolve => { window.releaseMicrophone = resolve })
          return native.apply(this, args)
        }
      }
    }, pending)
    await page.reload()
    await page.waitForFunction(() => typeof window.releaseMicrophone === 'function')
    await page.getByRole('button', { name: 'Continue to room' }).click()
    await expect(roomReady(page)).toBeAttached({ timeout: 2000 })
    await page.evaluate(() => window.releaseMicrophone())
    await expect(page.locator('#mic-select')).toHaveAttribute('aria-busy', 'false')
  })
}

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
