import { readFileSync } from 'node:fs'
import vm from 'node:vm'
import { describe, it, expect } from 'vitest'

const source = readFileSync(new URL('../../static/worklet/recorder-processor.js', import.meta.url), 'utf8')
function processor() {
  let Processor
  const messages = []
  vm.runInNewContext(source, {
    // Share mutation activation and coverage across the worklet VM boundary.
    __stryker__: globalThis.__stryker__,
    sampleRate: 48000,
    AudioWorkletProcessor: class { port = { postMessage: message => messages.push(message) } },
    registerProcessor: (_, type) => { Processor = type }
  })
  const p = new Processor()
  const send = type => p.port.onmessage({ data: { type, id: 1 } })
  const render = (value, length = 128) => p.process(value == null ? [[]] : [[new Float32Array(length).fill(value)]], [[new Float32Array(length)]])
  return { p, messages, send, render, chunks: () => messages.filter(m => m.type === 'data').map(m => [...m.buffer]) }
}

describe('actual recording worklet', () => {
  it('does not emit captured audio before the first take starts', () => {
    const p = processor()
    p.render(0.5, 8192)
    expect(p.chunks()).toEqual([])
  })

  it('posts complete chunks during capture without waiting for Stop, and stays alive', () => {
    const p = processor()
    p.send('start')
    for (let i = 0; i < 64; i++) expect(p.render(0.25)).toBe(true)
    expect(p.chunks()).toEqual([Array(8192).fill(0.25)])
    for (let i = 0; i < 64; i++) p.render(-0.25)
    expect(p.chunks()).toEqual([Array(8192).fill(0.25), Array(8192).fill(-0.25)])
  })

  it('captures silence when the entire input structure is missing', () => {
    const p = processor()
    p.send('start')
    for (const input of [undefined, [], [[]]]) {
      expect(p.p.process(input, [[new Float32Array(128)]])).toBe(true)
    }
    p.send('stop')
    expect(p.chunks()).toEqual([Array(384).fill(0)])
  })

  it('reports negative peaks and RMS only when a full level window is available', () => {
    const p = processor()
    for (let i = 0; i < 15; i++) p.render(-0.5)
    expect(p.messages.filter(message => message.type === 'level')).toEqual([])
    p.render(0.25)
    const levels = p.messages.filter(message => message.type === 'level')
    expect(levels).toHaveLength(1)
    expect(levels[0].peak).toBe(0.5)
    expect(levels[0].rms).toBeCloseTo(Math.sqrt((15 * 0.5 ** 2 + 0.25 ** 2) / 16))
    for (let i = 0; i < 16; i++) p.render(0)
    expect(p.messages.filter(message => message.type === 'level').at(-1)).toEqual({ type: 'level', rms: 0, peak: 0 })
  })

  it('records a short, faded 1.2 kHz clap marker and then returns to silence', () => {
    const p = processor()
    p.send('start')
    p.send('clap')
    p.render(0, 4800)
    p.send('stop')
    const audio = p.chunks().flat()
    expect(audio).toHaveLength(4800)
    expect(audio[0]).toBe(0)
    expect(audio[1]).toBeGreaterThan(0)
    expect(Math.max(...audio)).toBeCloseTo(0.7, 2)
    expect(Math.min(...audio)).toBeCloseTo(-0.7, 2)
    expect(audio.slice(1680).every(sample => sample === 0)).toBe(true) // 35 ms at 48 kHz
    expect(Math.max(...audio.slice(0, 32).map(Math.abs))).toBeLessThan(0.15)
    expect(Math.max(...audio.slice(1648, 1680).map(Math.abs))).toBeLessThan(0.15)
    const middle = audio.slice(240, 1440)
    const crossings = middle.slice(1).filter((sample, i) => middle[i] <= 0 && sample > 0).length
    expect(crossings * 48000 / middle.length).toBeCloseTo(1200, -2)
  })

  it('mixes the clap with incoming audio without clipping or replacing the microphone', () => {
    const p = processor()
    p.send('start')
    p.send('clap')
    p.render(0.95, 2400)
    p.send('stop')
    const audio = p.chunks().flat()
    expect(audio.every(sample => Number.isFinite(sample) && sample >= -1 && sample <= 1)).toBe(true)
    expect(Math.max(...audio)).toBe(1)
    expect(audio.slice(1680).every(sample => Math.abs(sample - 0.95) < 0.000001)).toBe(true)
  })

  it('keeps exact sample order across mic loss and reconnect within a chunk', () => {
    const p = processor()
    p.send('start')
    p.render(0.5, 100)
    p.render(null, 150)
    p.render(-0.5, 50)
    p.send('stop')
    expect(p.chunks()).toEqual([[...Array(100).fill(0.5), ...Array(150).fill(0), ...Array(50).fill(-0.5)]])
    expect(p.messages.at(-1)).toMatchObject({ type: 'stopped', id: 1 })
  })

  it('produces regular zero chunks without a microphone', () => {
    const p = processor()
    p.send('start')
    for (let i = 0; i < 64; i++) p.render(null)
    p.send('stop')
    expect(p.chunks()).toEqual([Array(8192).fill(0)])
  })

  it('flushes only the existing tail and never records before start or after stop', () => {
    const p = processor()
    p.render(1, 100)
    p.send('start')
    p.render(0.5, 100)
    p.send('stop')
    p.render(1, 100)
    p.send('stop')
    p.send('start')
    p.render(-0.5, 50)
    p.send('stop')
    expect(p.chunks()).toEqual([Array(100).fill(0.5), Array(50).fill(-0.5)])
  })

  it('keeps live level reporting outside recording', () => {
    const p = processor()
    for (let i = 0; i < 16; i++) p.render(0.5)
    expect(p.messages).toContainEqual({ type: 'level', rms: 0.5, peak: 0.5 })
    expect(p.chunks()).toEqual([])
  })
})
