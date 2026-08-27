import { test, expect } from '@playwright/test'

// Regression test for a real bug: a mid-recording mic reconnect used to get
// its silence recorded TWICE.
//
// gainNode stays connected to workletNode across every mic reconnect (only
// the micSource -> gainNode edge is ever touched — see connectMicNow in
// src/routes/rec/[slug]/+page.svelte), and workletNode is kept ticking for
// the whole session via silentSink -> audioCtx.destination. A GainNode with
// no live input still outputs real, correctly-timed zero samples every
// render quantum, so the AudioWorklet posts genuine digital silence through
// the ordinary writeChunk() path for the *entire* duration a mic is
// disconnected — automatically, with sample-accurate timing.
//
// The code used to ALSO call captureWriter.notifyDeviceGap() with a
// wall-clock-measured gap duration once the reconnect completed. That
// back-filled a second helping of silence for time that was already on
// disk, roughly doubling every gap and stretching the take out of sync —
// audible as stutter/misalignment, worse the more a loose connection blips.
//
// This drives the real recorder-processor.js worklet and the real
// capture-writer.js against a live (headless) AudioContext — no mocks for
// the mechanism under test — and asserts a disconnected-input window
// records ~1x its real duration, not ~2x.
test('a disconnected mic input records ~1x its real duration, never ~2x', async ({ page }) => {
  await page.route('**/__mic-gap-probe.html', (route) => {
    route.fulfill({
      status: 200,
      contentType: 'text/html',
      body: `<!doctype html><html><body>
      <button id="start">start</button>
      <script type="module">
        import { createCaptureWriter } from '/src/lib/capture-writer.js'

        function float32ToInt16(f32) {
          const i16 = new Int16Array(f32.length)
          for (let i = 0; i < f32.length; i++) {
            const s = Math.max(-1, Math.min(1, f32[i]))
            i16[i] = s < 0 ? s * 0x8000 : s * 0x7fff
          }
          return i16
        }

        // Mirrors the real recording graph: workletNode kept alive via a
        // silent path to destination, fed by a gainNode that (for this
        // test) never gets a live input connected — exactly the state
        // gainNode is in during the window between micSource.disconnect()
        // and the next successful getUserMedia() in connectMicNow().
        async function run() {
          const audioCtx = new AudioContext({ sampleRate: 48000 })
          if (audioCtx.state === 'suspended') { try { await audioCtx.resume() } catch {} }
          await audioCtx.audioWorklet.addModule('/worklet/recorder-processor.js')

          const workletNode = new AudioWorkletNode(audioCtx, 'recorder-processor')
          const silentSink = audioCtx.createGain()
          silentSink.gain.value = 0
          const gainNode = audioCtx.createGain()
          gainNode.connect(workletNode)
          workletNode.connect(silentSink)
          silentSink.connect(audioCtx.destination)

          const captureWriter = createCaptureWriter({ sampleRate: 48000, write: async () => {} })
          workletNode.port.onmessage = (e) => {
            if (e.data.type === 'data') captureWriter.writeChunk(float32ToInt16(e.data.buffer))
          }

          const t0 = audioCtx.currentTime
          await new Promise((r) => setTimeout(r, 1000))
          const gapSec = audioCtx.currentTime - t0

          // The fixed code path: no notifyDeviceGap() call here at all —
          // see the NOTE above captureWriter's declaration in +page.svelte.
          // The exact call the bug reintroduces would be:
          //   captureWriter.notifyDeviceGap(gapSec)

          await new Promise((r) => setTimeout(r, 50))
          const { samplesWritten } = await captureWriter.stop()
          window.__result = { gapSec, recordedSec: samplesWritten / 48000 }
        }
        // AudioContext.resume() needs a real user gesture under Chromium's
        // autoplay policy — a click via Playwright's CDP-driven input
        // counts as one; a script auto-running on load does not.
        document.getElementById('start').addEventListener('click', run)
      </script></body></html>`
    })
  })

  await page.goto('/__mic-gap-probe.html')
  await page.click('#start')
  await page.waitForFunction(() => window.__result !== undefined, { timeout: 15000 })
  const { gapSec, recordedSec } = await page.evaluate(() => window.__result)

  // Real gap was ~1s. A correct recording is ~1x that (small positive slop
  // from the worklet's 8192-sample chunking is expected). The old,
  // double-counting bug produced ~2x — assert well below that line.
  expect(recordedSec).toBeGreaterThan(gapSec * 0.8)
  expect(recordedSec).toBeLessThan(gapSec * 1.5)
})
