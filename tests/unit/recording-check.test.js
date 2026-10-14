import { describe, it, expect, afterEach, vi } from 'vitest'
import { CHECK_TURN } from '../../src/lib/recording/recording-check-share.js'
import { CHECK_SENTENCES, createRecordingCheck, createCheckTurnSequence } from '../../src/lib/recording/recording-check.js'

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
    expect(check.buildPreview(48000).size).toBe(44)
  })

  it('handleWritten() buffers whole chunks while under the cap, then drops further chunks entirely', () => {
    const check = createRecordingCheck({ maxPreviewSamples: 5 })
    check.start()
    check.handleWritten(new Int16Array([1, 2, 3]))
    check.handleWritten(new Int16Array([4, 5, 6, 7, 8]))
    check.handleWritten(new Int16Array([9, 10]))

    expect(check.buildPreview(48000).size).toBe(44 + (3 + 5) * 2)
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

  it('close() uses the same close-and-clear behavior for stop-button cleanup', () => {
    const check = createRecordingCheck()
    check.start()
    check.handleWritten(new Int16Array([1, 2, 3]))
    check.close()
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

  it('sharePcm() is empty until start() has written samples', () => {
    const check = createRecordingCheck()
    expect(Array.from(check.sharePcm())).toEqual([])
    check.start()
    expect(Array.from(check.sharePcm())).toEqual([])
  })

  it('sharePcm() returns written samples up to maxShareSamples, not the full 30s preview cap', () => {
    const check = createRecordingCheck({ maxPreviewSamples: 20, maxShareSamples: 4 })
    check.start()
    check.handleWritten(new Int16Array([1, 2, 3, 4, 5, 6]))
    expect(Array.from(check.sharePcm())).toEqual([1, 2, 3, 4])
    check.handleWritten(new Int16Array([7, 8, 9]))
    expect(Array.from(check.sharePcm())).toEqual([1, 2, 3, 4])
  })

  it('consumeAutoShare() fires once when written samples first reach shareAfterSamples', () => {
    const check = createRecordingCheck({ shareAfterSamples: 5, maxShareSamples: 20 })
    check.start()
    check.handleWritten(new Int16Array([1, 2, 3]))
    expect(check.consumeAutoShare()).toBe(false)
    check.handleWritten(new Int16Array([4, 5, 6]))
    expect(check.consumeAutoShare()).toBe(true)
    expect(check.consumeAutoShare()).toBe(false)
    check.handleWritten(new Int16Array([7, 8]))
    expect(check.consumeAutoShare()).toBe(false)
  })

  it('a new start() allows auto-share to fire again', () => {
    const check = createRecordingCheck({ shareAfterSamples: 2 })
    check.start()
    check.handleWritten(new Int16Array([1, 2]))
    expect(check.consumeAutoShare()).toBe(true)
    check.confirm()
    check.start()
    check.handleWritten(new Int16Array([9, 8]))
    expect(check.consumeAutoShare()).toBe(true)
  })
})

describe('createCheckTurnSequence', () => {
  it('synced start is the host turn; guest check UI stays inert until host confirm()', () => {
    const seq = createCheckTurnSequence()
    seq.start({ synced: true })
    expect(seq.turn).toBe(CHECK_TURN.host)
    expect(seq.bothTurnsPassed).toBe(false)
    expect(seq.shouldOpenOwnCheck({ isHost: true })).toBe(true)
    expect(seq.shouldOpenOwnCheck({ isHost: false })).toBe(false)

    seq.confirm({ isHost: true })
    expect(seq.turn).toBe(CHECK_TURN.guest)
    expect(seq.bothTurnsPassed).toBe(false)
    expect(seq.shouldOpenOwnCheck({ isHost: true })).toBe(false)
    expect(seq.shouldOpenOwnCheck({ isHost: false })).toBe(true)
  })

  it('guest confirm() after host confirm() is the one both-turns-passed state', () => {
    const seq = createCheckTurnSequence()
    const passed = []
    seq.onBothTurnsPassed(() => passed.push(seq.turn))
    seq.start({ synced: true })
    seq.confirm({ isHost: true })
    expect(passed).toEqual([])
    seq.confirm({ isHost: false })
    expect(seq.turn).toBe(CHECK_TURN.passed)
    expect(seq.bothTurnsPassed).toBe(true)
    expect(passed).toEqual([CHECK_TURN.passed])
    seq.confirm({ isHost: false })
    expect(passed).toEqual([CHECK_TURN.passed])
  })

  it('host reject() stays on the host turn and does not pass', () => {
    const seq = createCheckTurnSequence()
    seq.start({ synced: true })
    seq.reject({ isHost: true })
    expect(seq.turn).toBe(CHECK_TURN.host)
    expect(seq.bothTurnsPassed).toBe(false)
    expect(seq.shouldOpenOwnCheck({ isHost: true })).toBe(true)
    expect(seq.shouldOpenOwnCheck({ isHost: false })).toBe(false)
  })

  it('guest reject() returns to the host turn without passing or flipping the host into a guest check', () => {
    const seq = createCheckTurnSequence()
    seq.start({ synced: true })
    seq.confirm({ isHost: true })
    expect(seq.turn).toBe(CHECK_TURN.guest)
    seq.reject({ isHost: false })
    expect(seq.turn).toBe(CHECK_TURN.host)
    expect(seq.bothTurnsPassed).toBe(false)
    expect(seq.shouldOpenOwnCheck({ isHost: true })).toBe(true)
    expect(seq.shouldOpenOwnCheck({ isHost: false })).toBe(false)
  })

  it('reject() on the other peer turn does not advance or rewrite whose turn it is', () => {
    const seq = createCheckTurnSequence()
    seq.start({ synced: true })
    seq.reject({ isHost: false })
    expect(seq.turn).toBe(CHECK_TURN.host)
    seq.confirm({ isHost: true })
    seq.reject({ isHost: true })
    expect(seq.turn).toBe(CHECK_TURN.guest)
    expect(seq.bothTurnsPassed).toBe(false)
  })

  it('stayQuietRole follows the current turn and does not read mic level', () => {
    const seq = createCheckTurnSequence()
    seq.start({ synced: true })
    expect(seq.stayQuietRole({ isHost: false, micLevel: 0.9 })).toBe(CHECK_TURN.host)
    expect(seq.stayQuietRole({ isHost: true, micLevel: 0 })).toBe(null)
    seq.confirm({ isHost: true })
    expect(seq.stayQuietRole({ isHost: true, micLevel: 1 })).toBe(CHECK_TURN.guest)
    expect(seq.stayQuietRole({ isHost: false, micLevel: 0 })).toBe(null)
  })

  it('solo start opens this peer check and passes on confirm without a guest turn', () => {
    const seq = createCheckTurnSequence()
    const passed = []
    seq.onBothTurnsPassed(() => passed.push(true))
    seq.start({ synced: false })
    expect(seq.turn).toBe(CHECK_TURN.idle)
    expect(seq.shouldOpenOwnCheck({ isHost: true })).toBe(true)
    expect(seq.shouldOpenOwnCheck({ isHost: false })).toBe(true)
    expect(seq.stayQuietRole({ isHost: false })).toBe(null)
    seq.confirm({ isHost: false })
    expect(seq.bothTurnsPassed).toBe(true)
    expect(passed).toEqual([true])
  })

  it('solo reject() does not pass and keeps own check available', () => {
    const seq = createCheckTurnSequence()
    seq.start({ synced: false })
    seq.reject({ isHost: true })
    expect(seq.bothTurnsPassed).toBe(false)
    expect(seq.shouldOpenOwnCheck({ isHost: true })).toBe(true)
  })

  it('applyRemote mirrors a relayed turn so the other peer can open or stay quiet', () => {
    const seq = createCheckTurnSequence()
    seq.applyRemote(CHECK_TURN.host)
    expect(seq.turn).toBe(CHECK_TURN.host)
    expect(seq.shouldOpenOwnCheck({ isHost: false })).toBe(false)
    seq.applyRemote(CHECK_TURN.guest)
    expect(seq.shouldOpenOwnCheck({ isHost: false })).toBe(true)
    seq.applyRemote(CHECK_TURN.passed)
    expect(seq.bothTurnsPassed).toBe(true)
  })
})
