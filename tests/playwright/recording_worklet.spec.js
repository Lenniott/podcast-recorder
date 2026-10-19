import { test, expect } from '@playwright/test'

test('real worklet records silence without input and isolates consecutive takes', async ({ page }) => {
  await page.goto('/')
  const result = await page.evaluate(async () => {
    const ctx = new AudioContext({ sampleRate: 48000 })
    await ctx.resume()
    await ctx.audioWorklet.addModule('/worklet/recorder-processor.js')
    const node = new AudioWorkletNode(ctx, 'recorder-processor')
    const mute = ctx.createGain()
    mute.gain.value = 0
    node.connect(mute).connect(ctx.destination)
    const source = ctx.createConstantSource()
    source.offset.value = 0.5
    source.start()
    let chunks = []
    let resolveChunk
    let resolveStop
    let levelCount = 0
    node.port.onmessage = ({ data }) => {
      if (data.type === 'level') levelCount++
      if (data.type === 'data') { chunks.push([...data.buffer]); resolveChunk?.() }
      if (data.type === 'stopped') resolveStop?.()
    }
    async function take(id, connected) {
      chunks = []
      if (connected) source.connect(node)
      const firstChunk = new Promise(resolve => { resolveChunk = resolve })
      node.port.postMessage({ type: 'start' })
      await firstChunk
      const stopped = new Promise(resolve => { resolveStop = resolve })
      node.port.postMessage({ type: 'stop', id })
      await stopped
      const saved = chunks.flat()
      const countAtStop = chunks.length
      // Render additional audio after Stop; only live levels may continue.
      await new Promise(resolve => setTimeout(resolve, 200))
      return { samples: saved.length, values: [...new Set(saved)], countAtStop, countLater: chunks.length }
    }
    const first = await take(1, false)
    const second = await take(2, true)
    source.stop()
    await ctx.close()
    return { first, second, levelCount }
  })
  expect(result.first.samples).toBeGreaterThanOrEqual(8192)
  expect(result.first.values).toEqual([0])
  expect(result.second.samples).toBeGreaterThanOrEqual(8192)
  expect(result.second.values).toEqual([0.5])
  expect(result.first.countLater).toBe(result.first.countAtStop)
  expect(result.second.countLater).toBe(result.second.countAtStop)
  expect(result.levelCount).toBeGreaterThan(0)
})

test('microphone assessment distinguishes silent and audible browser streams without stopping them', async ({ page }) => {
  await page.goto('/')
  const result = await page.evaluate(async () => {
    const { assessMicrophone, rankMicrophones } = await import('/src/lib/recording/microphones.js')
    const ctx = new AudioContext()
    await ctx.resume()
    const source = ctx.createOscillator()
    source.frequency.value = 400
    const audible = ctx.createMediaStreamDestination()
    const silent = ctx.createMediaStreamDestination()
    const mute = ctx.createGain()
    mute.gain.value = 0
    source.connect(audible)
    source.connect(mute).connect(silent)
    source.start()
    const quiet = await assessMicrophone({ deviceId: 'quiet' }, { audioContext: ctx, stream: silent.stream })
    const sound = await assessMicrophone({ deviceId: 'sound' }, { audioContext: ctx, stream: audible.stream })
    const order = rankMicrophones([quiet, sound], 'quiet').map(mic => mic.deviceId)
    const tracksLive = [silent, audible].every(dest => dest.stream.getAudioTracks()[0].readyState === 'live')
    source.stop()
    for (const dest of [silent, audible]) dest.stream.getTracks().forEach(track => track.stop())
    await ctx.close()
    return { quiet: quiet.status, sound: sound.status, order, tracksLive }
  })
  expect(result).toEqual({ quiet: 'no-signal', sound: 'signal', order: ['sound', 'quiet'], tracksLive: true })
})
