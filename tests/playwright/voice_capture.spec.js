import { test, expect } from '@playwright/test'
import { stubYouTubeApi, createRoom, joinAsGuest, passRecordingCheck } from './helpers.js'

/**
 * Ticket 03 (research-assistant): voice capture wired to the Record
 * button. Stubs window.SpeechRecognition/webkitSpeechRecognition via
 * page.addInitScript (must run before navigation) so a synthetic
 * `onresult` event can be fired directly — no real microphone, no real
 * speech recognition — mirroring transcript_tab.spec.js's pattern of
 * driving the room's live state directly rather than through a real
 * external dependency.
 */
async function stubSpeechRecognition(page) {
  await page.addInitScript(() => {
    class FakeSpeechRecognition {
      constructor() {
        window.__srInstances = window.__srInstances || []
        window.__srInstances.push(this)
        window.__srStartCount = (window.__srStartCount || 0) + 1
        this.onresult = null
        this.onend = null
        this.onerror = null
      }
      start() {
        // Real browsers fire onstart shortly after start() is called —
        // the status dot (RoomTabs.svelte) only reaches "running" once
        // that happens, same as speech-recognition.js's own retry logic
        // only resets its backoff on a confirmed onstart.
        queueMicrotask(() => this.onstart?.())
      }
      stop() {
        window.__srStopCount = (window.__srStopCount || 0) + 1
      }
    }
    window.SpeechRecognition = FakeSpeechRecognition
    window.webkitSpeechRecognition = FakeSpeechRecognition
  })
}

async function stubNoSpeechRecognition(page) {
  await page.addInitScript(() => {
    // Simulates Firefox/Safari, or a Blink browser missing it entirely.
    delete window.SpeechRecognition
    delete window.webkitSpeechRecognition
  })
}

function fireFinalResult(page, text) {
  return page.evaluate((text) => {
    const instance = window.__srInstances.at(-1)
    instance.onresult({
      resultIndex: 0,
      results: [Object.assign([{ transcript: text }], { isFinal: true })]
    })
  }, text)
}

test('Start Recording starts speech recognition; a finalized utterance appears in the Transcript tab; Stop Recording stops it', async ({ page }) => {
  await stubSpeechRecognition(page)
  await stubYouTubeApi(page)
  const password = 'voice-capture-happy'
  await createRoom(page, { name: `E2E Voice Capture ${Date.now()}`, password, hostDisplayName: 'Host' })

  await expect(page.getByRole('button', { name: 'Start Recording' })).toBeEnabled()
  await page.getByRole('button', { name: 'Start Recording' }).click()
  await expect(page.getByRole('button', { name: 'Stop Recording' })).toBeVisible()
  await passRecordingCheck(page)

  // Recognition starts the moment local recording starts — no separate
  // button, no separate consent step (ADR-0003).
  await expect.poll(() => page.evaluate(() => window.__srStartCount || 0)).toBeGreaterThan(0)

  // Status dot on the Transcript tab pill confirms a confirmed-running
  // session, not just an attempted one (speech-recognition.js only fires
  // onStatusChange('running') after the fake's onstart callback lands).
  await expect(page.locator('.transcription-status-dot')).toHaveAttribute('data-status', 'running')

  await fireFinalResult(page, 'Hello from the test.')

  await page.getByRole('button', { name: 'Transcript' }).click()
  await expect(page.locator('.transcript-line')).toHaveCount(1)
  await expect(page.locator('.transcript-line').first()).toContainText('Host')
  await expect(page.locator('.transcript-line').first()).toContainText('Hello from the test.')

  await page.getByRole('button', { name: 'Stop Recording' }).click()
  await expect.poll(() => page.evaluate(() => window.__srStopCount || 0)).toBeGreaterThan(0)
  await expect(page.getByRole('button', { name: 'Start Recording' })).toBeEnabled({ timeout: 20_000 })

  // Stopped is the "nothing to show" state — the dot itself is hidden.
  await expect(page.locator('.transcription-status-dot')).toHaveCount(0)

  await page.close()
})

test('an interim (non-final) result is never added to the Transcript tab', async ({ page }) => {
  await stubSpeechRecognition(page)
  await stubYouTubeApi(page)
  const password = 'voice-capture-interim'
  await createRoom(page, { name: `E2E Voice Capture Interim ${Date.now()}`, password, hostDisplayName: 'Host' })

  await page.getByRole('button', { name: 'Start Recording' }).click()
  await passRecordingCheck(page)
  await expect.poll(() => page.evaluate(() => window.__srStartCount || 0)).toBeGreaterThan(0)

  await page.evaluate(() => {
    const instance = window.__srInstances.at(-1)
    instance.onresult({
      resultIndex: 0,
      results: [Object.assign([{ transcript: 'still talking' }], { isFinal: false })]
    })
  })

  await page.getByRole('button', { name: 'Transcript' }).click()
  await expect(page.getByText('No transcript yet')).toBeVisible()
  await expect(page.locator('.transcript-line')).toHaveCount(0)

  await page.getByRole('button', { name: 'Stop Recording' }).click()
  await expect(page.getByRole('button', { name: 'Start Recording' })).toBeEnabled({ timeout: 20_000 })

  await page.close()
})

test('a browser without SpeechRecognition still records normally, with no error surfaced', async ({ page }) => {
  await stubNoSpeechRecognition(page)
  await stubYouTubeApi(page)

  const pageErrors = []
  page.on('pageerror', (err) => pageErrors.push(err))
  let dialogMessage = null
  page.on('dialog', async (dialog) => {
    dialogMessage = dialog.message()
    await dialog.dismiss()
  })

  const password = 'voice-capture-unsupported'
  await createRoom(page, { name: `E2E Voice Capture Unsupported ${Date.now()}`, password, hostDisplayName: 'Host' })

  await expect(page.getByRole('button', { name: 'Start Recording' })).toBeEnabled()
  await page.getByRole('button', { name: 'Start Recording' }).click()
  await expect(page.getByRole('button', { name: 'Stop Recording' })).toBeVisible()
  await passRecordingCheck(page)

  await page.getByRole('button', { name: 'Stop Recording' }).click()
  await expect(page.getByRole('button', { name: 'Start Recording' })).toBeEnabled({ timeout: 20_000 })

  expect(pageErrors).toEqual([])
  expect(dialogMessage).toBeNull()

  await page.close()
})

test('an interim result shows a room-shared "transcript incoming" pulse to every peer, which clears once the line finalizes', async ({ browser }) => {
  const host = await browser.newPage()
  await stubSpeechRecognition(host)
  await stubYouTubeApi(host)
  const password = 'voice-capture-activity'
  const roomUrl = await createRoom(host, { name: `E2E Voice Capture Activity ${Date.now()}`, password, hostDisplayName: 'Host' })

  const guest = await browser.newPage()
  await stubYouTubeApi(guest)
  await joinAsGuest(guest, roomUrl, { name: 'Guest', password })

  await host.getByRole('button', { name: 'Start Recording' }).click()
  await passRecordingCheck(host)
  await expect.poll(() => host.evaluate(() => window.__srStartCount || 0)).toBeGreaterThan(0)

  // Nothing said yet — no pulse for either peer.
  await expect(host.locator('.transcript-activity-pulse')).toHaveCount(0)
  await expect(guest.locator('.transcript-activity-pulse')).toHaveCount(0)

  await host.evaluate(() => {
    const instance = window.__srInstances.at(-1)
    instance.onresult({
      resultIndex: 0,
      results: [Object.assign([{ transcript: 'still tal' }], { isFinal: false })]
    })
  })

  // Room-shared: the guest sees it too, not just the peer whose mic picked
  // up the interim result.
  await expect(host.locator('.transcript-activity-pulse')).toBeVisible()
  await expect(guest.locator('.transcript-activity-pulse')).toBeVisible()

  await fireFinalResult(host, 'Still talking now.')

  // Finalizing clears it immediately, for both peers — not just after the
  // decay timer would eventually have fired.
  await expect(host.locator('.transcript-activity-pulse')).toHaveCount(0)
  await expect(guest.locator('.transcript-activity-pulse')).toHaveCount(0)

  await host.getByRole('button', { name: 'Stop Recording' }).click()
  await expect.poll(() => host.evaluate(() => window.__srStopCount || 0)).toBeGreaterThan(0)
  await expect(host.getByRole('button', { name: 'Start Recording' })).toBeEnabled({ timeout: 20_000 })

  await guest.close()
  await host.close()
})
