import { describe, it, expect, afterEach, vi } from 'vitest'
import { createRecordingCheck, CHECK_SENTENCES } from '../../src/lib/recording-check.js'

describe('createRecordingCheck', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('starts closed and not collecting', () => {
    const check = createRecordingCheck()
    expect(check.open).toBe(false)
    expect(check.sentence).toBe('')
  })

  it('start() opens with one of the known sentences', () => {
    const check = createRecordingCheck()
    check.start()
    expect(check.open).toBe(true)
    expect(CHECK_SENTENCES).toContain(check.sentence)
  })

  it('handleWritten() does not buffer before start() is called', () => {
    const check = createRecordingCheck()
    check.handleWritten(new Int16Array([1, 2, 3]))
    expect(check.buildPreview(48000).size).toBeGreaterThan(0) // header-only, no samples
    // 44-byte WAV header, no data appended
    expect(check.buildPreview(48000).size).toBe(44)
  })

  it('handleWritten() buffers whole chunks while under the cap, then drops further chunks entirely', () => {
    // The cap gates on the count *before* a chunk arrives — it doesn't slice
    // a chunk mid-way, so one in-flight chunk can push the total over the
    // cap; only the *next* chunk after that is dropped.
    const check = createRecordingCheck({ maxPreviewSamples: 5 })
    check.start()
    check.handleWritten(new Int16Array([1, 2, 3]))        // count 0 < 5 → included, count now 3
    check.handleWritten(new Int16Array([4, 5, 6, 7, 8]))  // count 3 < 5 → included, count now 8
    check.handleWritten(new Int16Array([9, 10]))          // count 8 >= 5 → dropped

    const blob = check.buildPreview(48000)
    expect(blob.size).toBe(44 + (3 + 5) * 2)
  })

  it('confirm() closes and clears the buffer', () => {
    const check = createRecordingCheck()
    check.start()
    check.handleWritten(new Int16Array([1, 2, 3]))
    check.confirm()
    expect(check.open).toBe(false)
    expect(check.buildPreview(48000).size).toBe(44)
  })

  it('reject() closes and clears the buffer', () => {
    const check = createRecordingCheck()
    check.start()
    check.handleWritten(new Int16Array([1, 2, 3]))
    check.reject()
    expect(check.open).toBe(false)
    expect(check.buildPreview(48000).size).toBe(44)
  })

  it('a fresh start() after confirm()/reject() clears any stale buffer', () => {
    const check = createRecordingCheck()
    check.start()
    check.handleWritten(new Int16Array([1, 2, 3]))
    check.confirm()

    check.start()
    expect(check.buildPreview(48000).size).toBe(44)
  })
})
