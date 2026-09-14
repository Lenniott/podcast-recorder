import { describe, it, expect, vi } from 'vitest'
import { createTranscriptCapture } from '../../src/lib/room/transcript-capture.js'

/**
 * Fake $lib/research/speech-recognition.js instance — this module's only
 * collaborator — injected via `createRecognition` so these tests never
 * touch a real (or even fake) browser SpeechRecognition constructor. The
 * fake captures whatever onResult callback createTranscriptCapture wired
 * up so a test can fire results directly, the same way
 * speech-recognition.test.js drives a fake recognizer's onresult.
 */
function createFakeRecognition(overrides = {}) {
  const calls = { start: 0, stop: 0 }
  let onResult = null
  let onStatusChange = null
  const recognition = {
    start: vi.fn(() => { calls.start++ }),
    stop: vi.fn(() => { calls.stop++ }),
    supported: overrides.supported ?? true,
    status: overrides.status ?? 'stopped'
  }
  const createRecognition = vi.fn((opts) => {
    onResult = opts.onResult
    onStatusChange = opts.onStatusChange
    return recognition
  })
  return {
    createRecognition,
    recognition,
    fireResult: (text, isFinal) => onResult(text, isFinal),
    fireStatusChange: (status) => onStatusChange?.(status)
  }
}

/**
 * Same shape as speech-recognition.test.js's own fakeClock — a decay timer
 * (ACTIVITY_DECAY_MS) is this module's own logic, not the recognizer's, so
 * it needs the same fake-timer control to test without a real 2-second
 * sleep.
 */
function fakeClock() {
  let nextId = 1
  const pending = new Map()
  return {
    setTimeoutFn: vi.fn((fn) => {
      const id = nextId++
      pending.set(id, fn)
      return id
    }),
    clearTimeoutFn: vi.fn((id) => { pending.delete(id) }),
    fireAll() {
      const fns = [...pending.values()]
      pending.clear()
      fns.forEach((fn) => fn())
    },
    pendingCount: () => pending.size
  }
}

describe('createTranscriptCapture', () => {
  it('start() starts the underlying recognition', () => {
    const { createRecognition, recognition } = createFakeRecognition()
    const capture = createTranscriptCapture({
      send: vi.fn(),
      getSpeakerName: () => 'Host',
      createRecognition
    })

    capture.start()

    expect(recognition.start).toHaveBeenCalledOnce()
  })

  it('stop() stops the underlying recognition', () => {
    const { createRecognition, recognition } = createFakeRecognition()
    const capture = createTranscriptCapture({
      send: vi.fn(),
      getSpeakerName: () => 'Host',
      createRecognition
    })

    capture.start()
    capture.stop()

    expect(recognition.stop).toHaveBeenCalledOnce()
  })

  it('sends exactly one transcript_line for a finalized utterance, labeled with the speaker', () => {
    const { createRecognition, fireResult } = createFakeRecognition()
    const send = vi.fn()
    const capture = createTranscriptCapture({ send, getSpeakerName: () => 'Host', createRecognition })

    capture.start()
    fireResult('Welcome to the show.', true)

    expect(send).toHaveBeenCalledOnce()
    expect(send).toHaveBeenCalledWith({ type: 'transcript_line', speaker: 'Host', text: 'Welcome to the show.' })
  })

  it('never sends a transcript_line for an interim (non-final) result', () => {
    const { createRecognition, fireResult } = createFakeRecognition()
    const send = vi.fn()
    const capture = createTranscriptCapture({ send, getSpeakerName: () => 'Host', createRecognition })

    capture.start()
    fireResult('Welcome to the sh', false)

    // It does send transcript_activity for the interim result — see the
    // dedicated "something's coming" describe block below — just never a
    // transcript_line, which only ever comes from a finalized result.
    expect(send).not.toHaveBeenCalledWith(expect.objectContaining({ type: 'transcript_line' }))
  })

  it('exposes the underlying recognition\'s supported flag', () => {
    const { createRecognition } = createFakeRecognition({ supported: false })
    const capture = createTranscriptCapture({ send: vi.fn(), getSpeakerName: () => 'Host', createRecognition })

    expect(capture.supported).toBe(false)
  })

  it('reads the speaker name fresh at send time, not once at construction', () => {
    const { createRecognition, fireResult } = createFakeRecognition()
    const send = vi.fn()
    let name = 'Host'
    const capture = createTranscriptCapture({ send, getSpeakerName: () => name, createRecognition })

    capture.start()
    name = 'Renamed Host'
    fireResult('Later line.', true)

    expect(send).toHaveBeenCalledWith({ type: 'transcript_line', speaker: 'Renamed Host', text: 'Later line.' })
  })

  it('never throws into the caller if send() itself throws', () => {
    const { createRecognition, fireResult } = createFakeRecognition()
    const send = vi.fn(() => { throw new Error('socket closed') })
    const capture = createTranscriptCapture({ send, getSpeakerName: () => 'Host', createRecognition })

    capture.start()
    expect(() => fireResult('Boom.', true)).not.toThrow()
  })

  it('start()/stop() never throw even if the underlying recognition throws', () => {
    const recognition = {
      start: vi.fn(() => { throw new Error('boom') }),
      stop: vi.fn(() => { throw new Error('boom') }),
      supported: true
    }
    const createRecognition = vi.fn(() => recognition)
    const capture = createTranscriptCapture({ send: vi.fn(), getSpeakerName: () => 'Host', createRecognition })

    expect(() => capture.start()).not.toThrow()
    expect(() => capture.stop()).not.toThrow()
  })

  it('forwards onStatusChange straight through from the underlying recognition', () => {
    const { createRecognition, fireStatusChange } = createFakeRecognition()
    const onStatusChange = vi.fn()
    createTranscriptCapture({ send: vi.fn(), getSpeakerName: () => 'Host', onStatusChange, createRecognition })

    fireStatusChange('retrying')

    expect(onStatusChange).toHaveBeenCalledWith('retrying')
  })

  it('exposes the underlying recognition\'s current status', () => {
    const { createRecognition } = createFakeRecognition({ status: 'running' })
    const capture = createTranscriptCapture({ send: vi.fn(), getSpeakerName: () => 'Host', createRecognition })

    expect(capture.status).toBe('running')
  })

  it('never sends for a finalized result that is empty or whitespace-only', () => {
    const { createRecognition, fireResult } = createFakeRecognition()
    const send = vi.fn()
    const capture = createTranscriptCapture({ send, getSpeakerName: () => 'Host', createRecognition })

    capture.start()
    fireResult('   ', true)

    expect(send).not.toHaveBeenCalled()
  })
})

describe('createTranscriptCapture — transcript_activity ("something\'s coming" pulse)', () => {
  it('sends active:true the moment an interim result arrives', () => {
    const { createRecognition, fireResult } = createFakeRecognition()
    const send = vi.fn()
    const clock = fakeClock()
    const capture = createTranscriptCapture({ send, getSpeakerName: () => 'Host', createRecognition, ...clock })

    capture.start()
    fireResult('still tal', false)

    expect(send).toHaveBeenCalledWith({ type: 'transcript_activity', active: true })
  })

  it('never sends activity for a blank interim result', () => {
    const { createRecognition, fireResult } = createFakeRecognition()
    const send = vi.fn()
    const clock = fakeClock()
    const capture = createTranscriptCapture({ send, getSpeakerName: () => 'Host', createRecognition, ...clock })

    capture.start()
    fireResult('   ', false)

    expect(send).not.toHaveBeenCalled()
  })

  it('does not resend active:true on a second interim result while already active', () => {
    const { createRecognition, fireResult } = createFakeRecognition()
    const send = vi.fn()
    const clock = fakeClock()
    const capture = createTranscriptCapture({ send, getSpeakerName: () => 'Host', createRecognition, ...clock })

    capture.start()
    fireResult('still', false)
    fireResult('still talk', false)

    expect(send).toHaveBeenCalledTimes(1)
  })

  it('sends active:false immediately once the line finalizes, without waiting for the decay timer', () => {
    const { createRecognition, fireResult } = createFakeRecognition()
    const send = vi.fn()
    const clock = fakeClock()
    const capture = createTranscriptCapture({ send, getSpeakerName: () => 'Host', createRecognition, ...clock })

    capture.start()
    fireResult('still talking', false)
    send.mockClear()
    fireResult('still talking now.', true)

    expect(send).toHaveBeenCalledWith({ type: 'transcript_activity', active: false })
    // The decay timer that was pending for the interim result is cleared,
    // not left to separately fire an already-redundant active:false later.
    expect(clock.pendingCount()).toBe(0)
  })

  it('sends active:false on its own after no further interim results arrive (decay)', () => {
    const { createRecognition, fireResult } = createFakeRecognition()
    const send = vi.fn()
    const clock = fakeClock()
    const capture = createTranscriptCapture({ send, getSpeakerName: () => 'Host', createRecognition, ...clock })

    capture.start()
    fireResult('still talking', false)
    send.mockClear()

    clock.fireAll()

    expect(send).toHaveBeenCalledWith({ type: 'transcript_activity', active: false })
  })

  it('resets the decay timer on each new interim result rather than letting an earlier one fire mid-utterance', () => {
    const { createRecognition, fireResult } = createFakeRecognition()
    const send = vi.fn()
    const clock = fakeClock()
    const capture = createTranscriptCapture({ send, getSpeakerName: () => 'Host', createRecognition, ...clock })

    capture.start()
    fireResult('still', false)
    fireResult('still talking', false)

    // Only ever one decay timer pending at a time, not one per interim result.
    expect(clock.pendingCount()).toBe(1)
  })

  it('clears activity when the recognizer stops', () => {
    const { createRecognition, fireResult, fireStatusChange } = createFakeRecognition()
    const send = vi.fn()
    const clock = fakeClock()
    const capture = createTranscriptCapture({ send, getSpeakerName: () => 'Host', createRecognition, ...clock })

    capture.start()
    fireResult('still talking', false)
    send.mockClear()

    fireStatusChange('stopped')

    expect(send).toHaveBeenCalledWith({ type: 'transcript_activity', active: false })
  })

  it('clears activity when the recognizer starts retrying', () => {
    const { createRecognition, fireResult, fireStatusChange } = createFakeRecognition()
    const send = vi.fn()
    const clock = fakeClock()
    const capture = createTranscriptCapture({ send, getSpeakerName: () => 'Host', createRecognition, ...clock })

    capture.start()
    fireResult('still talking', false)
    send.mockClear()

    fireStatusChange('retrying')

    expect(send).toHaveBeenCalledWith({ type: 'transcript_activity', active: false })
  })

  it('never throws into the caller if send() itself throws while reporting activity', () => {
    const { createRecognition, fireResult } = createFakeRecognition()
    const send = vi.fn(() => { throw new Error('socket closed') })
    const clock = fakeClock()
    const capture = createTranscriptCapture({ send, getSpeakerName: () => 'Host', createRecognition, ...clock })

    capture.start()
    expect(() => fireResult('still talking', false)).not.toThrow()
  })

  it('a stopped/retrying status change with no prior activity does not spuriously send active:false', () => {
    const { createRecognition, fireStatusChange } = createFakeRecognition()
    const send = vi.fn()
    const clock = fakeClock()
    createTranscriptCapture({ send, getSpeakerName: () => 'Host', createRecognition, ...clock })

    fireStatusChange('stopped')

    expect(send).not.toHaveBeenCalled()
  })
})
