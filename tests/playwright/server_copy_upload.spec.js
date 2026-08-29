import { test, expect } from '@playwright/test'
import { readFileSync, statSync } from 'fs'
import { stubYouTubeApi, createRoom, joinAsGuest, passRecordingCheck } from './helpers.js'

/**
 * Server-copy upload/download, end to end (ticket 13). The unit tests
 * (server-copy-status.test.js, server-copy-upload.test.js) already prove
 * the pure state-derivation logic in isolation; this file proves the real
 * UI actually wires that logic to a real recording, a real HTTP upload,
 * and a real file download — not just mocks calling pure functions.
 *
 * `guest` is always the one recording here, deliberately, not the host —
 * this suite is gated on ticket 11 (clientId-owning capability token
 * minted per-connection over the WS), so a guest's upload succeeding is
 * the case that actually exercises that wiring end to end.
 */

/** Reads the `NN%` suffix off a server-copy pill's text, or null if the
 *  pill isn't currently in its percent-bearing (in_progress) state. */
async function readPercent(pillLocator) {
  const count = await pillLocator.count()
  if (count === 0) return null
  const text = await pillLocator.first().textContent()
  const match = text?.match(/(\d+)%/)
  return match ? Number(match[1]) : null
}

function guestPeerRow(page) {
  return page.locator('.peer', { hasText: 'Alex' })
}

function peerRow(page, name) {
  return page.locator('.peer', { hasText: name })
}

/**
 * Adds artificial per-request latency (never a failure — every request
 * still `route.continue()`s) to a participant's chunk uploads. On this
 * machine's `npm run dev`, chunk POSTs round-trip fast enough that
 * ackedBytes barely ever lags confirmedBytes — real audio chunks land
 * roughly every ~170ms (BUFFER_SIZE=8192 @ 48kHz), but an unthrottled
 * localhost chunk upload can easily complete faster than that, so the
 * pill reads 100% almost the entire time and a percent-progression
 * assertion would only ever catch that by sheer luck. This closes that
 * gap deliberately: it's still a genuine upload of genuine audio, just
 * slow enough that a real, observable backlog (ackedBytes < confirmedBytes)
 * exists for a real stretch of wall-clock time.
 */
async function slowServerCopyChunks(page, delayMs) {
  await page.route('**/server-copy/chunks*', async (route) => {
    await new Promise((r) => setTimeout(r, delayMs))
    await route.continue()
  })
}

function readMonoPcm16Wav(filePath) {
  const wav = readFileSync(filePath)
  expect(wav.toString('ascii', 0, 4)).toBe('RIFF')
  expect(wav.toString('ascii', 8, 12)).toBe('WAVE')

  const channels = wav.readUInt16LE(22)
  const sampleRate = wav.readUInt32LE(24)
  const bitsPerSample = wav.readUInt16LE(34)
  expect(channels).toBe(1)
  expect(bitsPerSample).toBe(16)

  let offset = 12
  while (offset + 8 <= wav.length) {
    const id = wav.toString('ascii', offset, offset + 4)
    const size = wav.readUInt32LE(offset + 4)
    if (id === 'data') {
      const sampleCount = Math.floor(size / 2)
      const samples = new Int16Array(sampleCount)
      for (let i = 0; i < sampleCount; i++) {
        samples[i] = wav.readInt16LE(offset + 8 + i * 2)
      }
      return { sampleRate, samples }
    }
    offset += 8 + size + (size % 2)
  }
  throw new Error(`No data chunk found in WAV: ${filePath}`)
}

function goertzelPower(samples, start, windowSize, sampleRate, freq) {
  const coeff = 2 * Math.cos((2 * Math.PI * freq) / sampleRate)
  let s1 = 0
  let s2 = 0
  for (let i = 0; i < windowSize; i++) {
    const x = samples[start + i] / 32768
    const s0 = x + coeff * s1 - s2
    s2 = s1
    s1 = s0
  }
  return s1 * s1 + s2 * s2 - coeff * s1 * s2
}

function countClapToneBursts({ sampleRate, samples }) {
  const windowSize = Math.min(2048, samples.length)
  const step = 512
  const minClusterGapSeconds = 0.18
  const bursts = []

  for (let start = 0; start + windowSize <= samples.length; start += step) {
    let sumSq = 0
    for (let i = 0; i < windowSize; i++) {
      const x = samples[start + i] / 32768
      sumSq += x * x
    }
    const rms = Math.sqrt(sumSq / windowSize)

    const target = goertzelPower(samples, start, windowSize, sampleRate, 1200)
    const lower = goertzelPower(samples, start, windowSize, sampleRate, 900)
    const upper = goertzelPower(samples, start, windowSize, sampleRate, 1500)
    const toneScore = target / (Math.max(lower, upper) + 1e-9)
    if (rms < 0.08 || toneScore < 8) continue

    const seconds = start / sampleRate
    if (bursts.length === 0 || seconds - bursts[bursts.length - 1] > minClusterGapSeconds) {
      bursts.push(seconds)
    } else {
      bursts[bursts.length - 1] = seconds
    }
  }

  return bursts.length
}

async function downloadServerCopy(page, name) {
  const downloadLink = peerRow(page, name).locator('[data-testid="server-copy-download"]')
  await expect(downloadLink).toBeVisible({ timeout: 15_000 })
  const [download] = await Promise.all([page.waitForEvent('download'), downloadLink.click()])
  const filePath = await download.path()
  expect(filePath).toBeTruthy()
  return filePath
}

test('server copy percent pill progresses on both browsers and reaches complete after stopping', async ({ browser }) => {
  const host = await browser.newPage()
  await stubYouTubeApi(host)
  const password = 'sc-happy'
  const roomUrl = await createRoom(host, { name: `E2E SC Happy ${Date.now()}`, password })

  const guest = await browser.newPage()
  await stubYouTubeApi(guest)
  await joinAsGuest(guest, roomUrl, { name: 'Alex', password })

  // See slowServerCopyChunks' doc comment: without this, a fast local dev
  // server round-trips chunk uploads quickly enough that the percent
  // reading is 100% almost the entire time, making the "genuine partial
  // progress" assertion below nearly impossible to actually observe.
  await slowServerCopyChunks(guest, 220)

  await expect(guest.getByRole('button', { name: 'Start Recording' })).toBeEnabled()
  await guest.getByRole('button', { name: 'Start Recording' }).click()
  await expect(guest.getByRole('button', { name: 'Stop Recording' })).toBeVisible()
  await passRecordingCheck(guest) // clears .check-overlay so Stop Recording is clickable later

  // Real (fake-device) audio capture writes an 8192-sample chunk roughly
  // every ~170ms (see static/worklet/recorder-processor.js's BUFFER_SIZE).
  // Sample both browsers' percent readouts across a real multi-second
  // window so we actually observe a genuine < 100% moment — not just the
  // instant jump to "done" a too-short recording (or a broken progress
  // calculation) would produce. This loop is the intentional "wait
  // condition" here: it's sampling live progress *during* a deliberately
  // real-time-bound recording, not standing in for one.
  const samplesHost = []
  const samplesGuest = []
  const sampleUntil = Date.now() + 4000
  while (Date.now() < sampleUntil) {
    samplesHost.push(await readPercent(guestPeerRow(host).locator('.pill-copy-progress')))
    samplesGuest.push(await readPercent(guestPeerRow(guest).locator('.pill-copy-progress')))
    await guest.waitForTimeout(120)
  }

  // Both browsers must have seen the in-progress pill at all (ticket 06's
  // "both peers see the same state" claim) with a real percent value...
  expect(samplesHost.some((p) => p !== null)).toBe(true)
  expect(samplesGuest.some((p) => p !== null)).toBe(true)
  // ...and at least one of those readings must be a genuine partial
  // value, not just 100% every time (which is what a stub/instant-jump
  // regression would produce).
  expect(samplesHost.some((p) => p !== null && p < 100)).toBe(true)
  expect(samplesGuest.some((p) => p !== null && p < 100)).toBe(true)

  await guest.getByRole('button', { name: 'Stop Recording' }).click()
  // Generous timeout: stopRecording() drains captureWriter's queued writes
  // and patches the WAV header before recordingState flips back to idle —
  // on this machine that's comfortably under a second, but a loaded/cold
  // sandbox can push it well past Playwright's 5s default (observed).
  await expect(guest.getByRole('button', { name: 'Start Recording' })).toBeEnabled({ timeout: 20_000 })

  await expect(guestPeerRow(host).locator('.pill-copy-complete')).toBeVisible({ timeout: 15_000 })
  await expect(guestPeerRow(guest).locator('.pill-copy-complete')).toBeVisible({ timeout: 15_000 })

  await guest.close()
  await host.close()
})

test('post-stop wait modal shows a percentage and auto-closes once the copy completes', async ({ browser }) => {
  const host = await browser.newPage()
  await stubYouTubeApi(host)
  const password = 'sc-wait-modal'
  const roomUrl = await createRoom(host, { name: `E2E SC Wait Modal ${Date.now()}`, password })

  const guest = await browser.newPage()
  await stubYouTubeApi(guest)
  await joinAsGuest(guest, roomUrl, { name: 'Alex', password })

  // Slow (never fail) every chunk upload so the server copy is still
  // reliably "catching up" for a real window right after Stop is clicked
  // — long enough to actually observe the post-stop modal rather than
  // racing a same-tick completion. Chunks still succeed, so this session
  // ends in `complete`, not `failed`.
  await slowServerCopyChunks(guest, 350)

  await expect(guest.getByRole('button', { name: 'Start Recording' })).toBeEnabled()
  await guest.getByRole('button', { name: 'Start Recording' }).click()
  await expect(guest.getByRole('button', { name: 'Stop Recording' })).toBeVisible()
  await passRecordingCheck(guest)
  await guest.waitForTimeout(1500) // let a handful of chunks queue up behind the slow route
  await guest.getByRole('button', { name: 'Stop Recording' }).click()

  const waitModal = guest.locator('.wait-overlay')
  // Generous timeout: the modal only renders once recordingState flips to
  // 'idle', which happens after stopRecording()'s writer-drain + WAV-header
  // patch settle (same sandbox-timing note as the happy-path spec above).
  await expect(waitModal).toBeVisible({ timeout: 20_000 })
  await expect(waitModal.locator('.wait-percent')).toHaveText(/\d+%/)

  // Auto-close: the modal has no explicit close button (see
  // ServerCopyWaitModal.svelte's doc comment) — it must disappear on its
  // own the instant the upload state reaches `complete`.
  await expect(waitModal).toBeHidden({ timeout: 20_000 })
  await expect(guestPeerRow(guest).locator('.pill-copy-complete')).toBeVisible()

  await guest.close()
  await host.close()
})

test('incomplete-upload exit warning is softer than the active-recording warning', async ({ browser }) => {
  const host = await browser.newPage()
  await stubYouTubeApi(host)
  const password = 'sc-exit-warn'
  const roomUrl = await createRoom(host, { name: `E2E SC Exit Warn ${Date.now()}`, password })

  const guest = await browser.newPage()
  await stubYouTubeApi(guest)
  await joinAsGuest(guest, roomUrl, { name: 'Alex', password })

  // Same slow-but-succeeding route as the wait-modal test above, so the
  // upload is reliably still `catching_up` (not yet `complete`, and never
  // `failed`) in the window right after Stop — exactly the state
  // isIncompleteServerCopyUpload/deriveExitGuard treat as the softer
  // "upload" severity (see $lib/exit-guard.js).
  await slowServerCopyChunks(guest, 350)

  await expect(guest.getByRole('button', { name: 'Start Recording' })).toBeEnabled()
  await guest.getByRole('button', { name: 'Start Recording' }).click()
  await expect(guest.getByRole('button', { name: 'Stop Recording' })).toBeVisible()
  await passRecordingCheck(guest)
  await guest.waitForTimeout(1500)
  await guest.getByRole('button', { name: 'Stop Recording' }).click()
  // Generous timeout — see the wait-modal spec's identical note above.
  await expect(guest.locator('.wait-overlay')).toBeVisible({ timeout: 20_000 })

  // Mirrors recording_status.spec.js's "active local recording warns
  // before in-app navigation" test exactly, but for the upload severity:
  // same in-app same-origin link + dialog-capture technique, different
  // (softer) expected copy.
  await guest.evaluate(() => {
    const link = document.createElement('a')
    link.href = '/'
    link.textContent = 'Leave room'
    link.dataset.testid = 'leave-room-link'
    link.style.position = 'fixed'
    link.style.top = '8px'
    link.style.left = '8px'
    link.style.zIndex = '2000'
    document.body.appendChild(link)
  })

  let message = ''
  guest.once('dialog', async (dialog) => {
    message = dialog.message()
    await dialog.dismiss()
  })

  await guest.getByTestId('leave-room-link').click()

  expect(message).toContain("recording is already saved on this device")
  expect(message).toContain('send the local file to the host another way')
  expect(message).not.toContain('WAV is finalized')
  await expect(guest).toHaveURL(roomUrl)

  await guest.close()
  await host.close()
})

test('host can download a completed server copy; a guest cannot see the control', async ({ browser }) => {
  const host = await browser.newPage()
  await stubYouTubeApi(host)
  const password = 'sc-download'
  const roomUrl = await createRoom(host, { name: `E2E SC Download ${Date.now()}`, password })
  const slug = new URL(roomUrl).pathname.split('/').pop()

  const guest = await browser.newPage()
  await stubYouTubeApi(guest)
  await joinAsGuest(guest, roomUrl, { name: 'Alex', password })

  await expect(guest.getByRole('button', { name: 'Start Recording' })).toBeEnabled()
  await guest.getByRole('button', { name: 'Start Recording' }).click()
  await expect(guest.getByRole('button', { name: 'Stop Recording' })).toBeVisible()
  await passRecordingCheck(guest)
  await guest.waitForTimeout(2000) // a few real seconds of audio to make a non-trivial WAV
  await guest.getByRole('button', { name: 'Stop Recording' }).click()
  // Generous timeout — see the happy-path spec's identical note above.
  await expect(guest.getByRole('button', { name: 'Start Recording' })).toBeEnabled({ timeout: 20_000 })

  const guestClientId = await guest.evaluate(() => sessionStorage.getItem('pr_clientId'))

  await expect(guestPeerRow(host).locator('.pill-copy-complete')).toBeVisible({ timeout: 15_000 })

  // Guest-can't-download, checked first (before the host's own download
  // navigates anywhere): the download route is host-only server-side, but
  // ticket 12's requirement is that a guest never even sees the control.
  await expect(guestPeerRow(guest).locator('[data-testid="server-copy-download"]')).toHaveCount(0)
  await expect(guest.locator('[data-testid="server-copy-download"]')).toHaveCount(0)

  const downloadLink = guestPeerRow(host).locator('[data-testid="server-copy-download"]')
  await expect(downloadLink).toBeVisible()

  const [download] = await Promise.all([host.waitForEvent('download'), downloadLink.click()])

  expect(download.suggestedFilename()).toBe(`${slug}-${guestClientId}.wav`)

  const filePath = await download.path()
  expect(filePath).toBeTruthy()
  const size = statSync(filePath).size
  // 44-byte WAV header alone would be a broken/empty download; a real
  // couple of seconds of 16-bit mono audio is comfortably >> that.
  expect(size).toBeGreaterThan(10_000)

  const header = readFileSync(filePath).subarray(0, 12)
  expect(header.toString('ascii', 0, 4)).toBe('RIFF')
  expect(header.toString('ascii', 8, 12)).toBe('WAVE')

  await guest.close()
  await host.close()
})

test('host and guest completed server copies contain every clap marker from the take', async ({ browser }) => {
  test.setTimeout(120_000)

  const host = await browser.newPage()
  await stubYouTubeApi(host)
  const password = 'sc-both-beeps'
  const roomUrl = await createRoom(host, {
    name: `E2E SC Both Beeps ${Date.now()}`,
    password,
    hostDisplayName: 'Host'
  })

  const guest = await browser.newPage()
  await stubYouTubeApi(guest)
  await joinAsGuest(guest, roomUrl, { name: 'Alex', password })

  await expect(host.getByRole('button', { name: 'Start Recording' })).toBeEnabled()
  await host.getByRole('button', { name: 'Start Recording' }).click()
  await expect(host.getByRole('button', { name: 'Stop Recording' })).toBeVisible()
  await passRecordingCheck(host)

  await expect(guest.getByRole('button', { name: 'Start Recording' })).toBeEnabled()
  await guest.getByRole('button', { name: 'Start Recording' }).click()
  await expect(guest.getByRole('button', { name: 'Stop Recording' })).toBeVisible()
  await passRecordingCheck(guest)

  await expect(peerRow(host, 'Host').locator('.pill-recording')).toBeVisible({ timeout: 15_000 })
  await expect(peerRow(host, 'Alex').locator('.pill-recording')).toBeVisible({ timeout: 15_000 })
  await expect(host.getByRole('button', { name: '👏 Clap' })).toBeEnabled()

  for (let i = 0; i < 3; i++) {
    await host.getByRole('button', { name: '👏 Clap' }).click()
    await expect(host.locator('.clap-flash')).toContainText('Sync clap', { timeout: 15_000 })
    await expect(guest.locator('.clap-flash')).toContainText('Sync clap', { timeout: 15_000 })
    await host.waitForTimeout(i === 2 ? 80 : 450)
  }

  // Stop both while the last marker is still recent. This specifically
  // protects the final worklet chunk: stopRecording() must keep accepting
  // chunks during its short "stopping" grace window before finalize.
  await Promise.all([
    host.getByRole('button', { name: 'Stop Recording' }).click(),
    guest.getByRole('button', { name: 'Stop Recording' }).click()
  ])
  await expect(host.getByRole('button', { name: 'Start Recording' })).toBeEnabled({ timeout: 20_000 })
  await expect(guest.getByRole('button', { name: 'Start Recording' })).toBeEnabled({ timeout: 20_000 })

  await expect(peerRow(host, 'Host').locator('.pill-copy-complete')).toBeVisible({ timeout: 20_000 })
  await expect(peerRow(host, 'Alex').locator('.pill-copy-complete')).toBeVisible({ timeout: 20_000 })

  const hostCopy = readMonoPcm16Wav(await downloadServerCopy(host, 'Host'))
  const guestCopy = readMonoPcm16Wav(await downloadServerCopy(host, 'Alex'))

  expect(countClapToneBursts(hostCopy)).toBeGreaterThanOrEqual(3)
  expect(countClapToneBursts(guestCopy)).toBeGreaterThanOrEqual(3)

  await guest.close()
  await host.close()
})
