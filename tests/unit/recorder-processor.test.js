import { readFileSync } from 'node:fs'
import vm from 'node:vm'
import { describe, it, expect } from 'vitest'

const source = readFileSync(new URL('../../static/worklet/recorder-processor.js', import.meta.url), 'utf8')
function processor() {
  let Processor
  const messages = []
  vm.runInNewContext(source, {
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
