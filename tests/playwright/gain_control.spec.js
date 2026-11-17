import { test, expect } from '@playwright/test'
import { createRoom, stubYouTubeApi } from './helpers.js'

test('the displayed gain and recording gain agree after every slider input', async ({ page }) => {
  await stubYouTubeApi(page)
  await page.addInitScript(() => {
    const native = AudioContext.prototype.createGain
    AudioContext.prototype.createGain = function () {
      const node = native.call(this)
      // The recording gain feeds both the worklet and live analyser.
      const connect = node.connect.bind(node)
      node.connect = (...args) => {
        if (args[0] instanceof AudioWorkletNode) window.recordingGain = node
        return connect(...args)
      }
      return node
    }
  })
  await createRoom(page, { name: `E2E Gain ${Date.now()}`, password: 'gain' })
  await page.waitForFunction(() => window.recordingGain)
  for (const db of [6, 0, -6, 12, 0]) {
    await page.locator('#gain-slider').evaluate((slider, db) => {
      slider.value = String(db)
      slider.dispatchEvent(new Event('input', { bubbles: true }))
    }, db)
    await expect(page.locator('.gain-db')).toHaveText(`${db > 0 ? '+' : ''}${db.toFixed(1)} dB`)
    expect(await page.evaluate(() => window.recordingGain.gain.value)).toBeCloseTo(10 ** (db / 20), 5)
  }
})
