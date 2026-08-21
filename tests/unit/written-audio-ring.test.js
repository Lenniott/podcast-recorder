import { describe, it, expect } from 'vitest'
import { createWrittenAudioRing } from '../../src/lib/written-audio-ring.js'

describe('createWrittenAudioRing', () => {
  it('reads back zeros before anything has been pushed', () => {
    const ring = createWrittenAudioRing(8)
    const out = new Float32Array(8)
    ring.read(out)
    expect(Array.from(out)).toEqual([0, 0, 0, 0, 0, 0, 0, 0])
  })

  it('right-aligns partial data with leading zeros when not yet full', () => {
    const ring = createWrittenAudioRing(8)
    ring.push(new Int16Array([32768 / 2, -32768 / 2, 0])) // 3 samples: 0.5, -0.5, 0
    const out = new Float32Array(8)
    ring.read(out)
    expect(Array.from(out)).toEqual([0, 0, 0, 0, 0, 0.5, -0.5, 0])
  })

  it('returns the most recent `size` samples in chronological order once full', () => {
    const ring = createWrittenAudioRing(4)
    // push 4 samples exactly filling it: 1,2,3,4 (as fractions of 32768)
    ring.push(new Int16Array([1, 2, 3, 4]))
    const out = new Float32Array(4)
    ring.read(out)
    expect(Array.from(out).map(v => Math.round(v * 32768))).toEqual([1, 2, 3, 4])
  })

  it('wraps around correctly, dropping the oldest samples first', () => {
    const ring = createWrittenAudioRing(4)
    ring.push(new Int16Array([1, 2, 3, 4]))
    ring.push(new Int16Array([5, 6])) // pushes out 1, 2 — ring now holds 3,4,5,6
    const out = new Float32Array(4)
    ring.read(out)
    expect(Array.from(out).map(v => Math.round(v * 32768))).toEqual([3, 4, 5, 6])
  })

  it('handles a push larger than the ring size — keeps only the tail', () => {
    const ring = createWrittenAudioRing(4)
    ring.push(new Int16Array([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]))
    const out = new Float32Array(4)
    ring.read(out)
    expect(Array.from(out).map(v => Math.round(v * 32768))).toEqual([7, 8, 9, 10])
  })

  it('read() can be called with an output shorter than the ring — returns the most recent slice', () => {
    const ring = createWrittenAudioRing(8)
    ring.push(new Int16Array([1, 2, 3, 4, 5, 6, 7, 8]))
    const out = new Float32Array(3)
    ring.read(out)
    expect(Array.from(out).map(v => Math.round(v * 32768))).toEqual([6, 7, 8])
  })

  it('read() can be called with an output longer than the ring — pads with leading zeros', () => {
    const ring = createWrittenAudioRing(4)
    ring.push(new Int16Array([1, 2, 3, 4]))
    const out = new Float32Array(6)
    ring.read(out)
    expect(Array.from(out).map(v => Math.round(v * 32768))).toEqual([0, 0, 1, 2, 3, 4])
  })
})
