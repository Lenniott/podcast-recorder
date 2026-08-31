import { describe, it, expect, vi } from 'vitest'
import { createTranscriptCapture } from '../../src/lib/transcript-capture.js'

/**
 * Fake $lib/speech-recognition.js instance — this module's only
 * collaborator — injected via `createRecognition` so these tests never
 * touch a real (or even fake) browser SpeechRecognition constructor. The
 * fake captures whatever onResult callback createTranscriptCapture wired
 * up so a test can fire results directly, the same way
 * speech-recognition.test.js drives a fake recognizer's onresult.
 */
function createFakeRecognition(overrides = {}) {
  const calls = { start: 0, stop: 0 }
  let onResult = null
  const recognition = {
    start: vi.fn(() => { calls.start++ }),
    stop: vi.fn(() => { calls.stop++ }),
    supported: overrides.supported ?? true
  }
  const createRecognition = vi.fn((opts) => {
    onResult = opts.onResult
    return recognition
  })
  return {
    createRecognition,
    recognition,
    fireResult: (text, isFinal) => onResult(text, isFinal)
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

  it('never sends for an interim (non-final) result', () => {
    const { createRecognition, fireResult } = createFakeRecognition()
    const send = vi.fn()
    const capture = createTranscriptCapture({ send, getSpeakerName: () => 'Host', createRecognition })

    capture.start()
    fireResult('Welcome to the sh', false)

    expect(send).not.toHaveBeenCalled()
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

  it('never sends for a finalized result that is empty or whitespace-only', () => {
    const { createRecognition, fireResult } = createFakeRecognition()
    const send = vi.fn()
    const capture = createTranscriptCapture({ send, getSpeakerName: () => 'Host', createRecognition })

    capture.start()
    fireResult('   ', true)

    expect(send).not.toHaveBeenCalled()
  })
})
