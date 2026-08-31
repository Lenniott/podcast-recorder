import { describe, it, expect, vi } from 'vitest'
import { createSpeechRecognition } from '../../src/lib/speech-recognition.js'

/**
 * A fake SpeechRecognition constructor mirroring audio-engine.test.js's
 * dependency-injection style for a browser API: each `new fakeCtor()` call
 * returns a fresh instance so tests can inspect exactly what was started/
 * stopped, and drive its onresult/onend/onerror handlers directly instead
 * of touching a real browser API.
 */
function createFakeRecognizerCtor() {
  const instances = []
  const ctor = vi.fn(function FakeRecognizer() {
    const instance = {
      start: vi.fn(),
      stop: vi.fn(),
      abort: vi.fn(),
      onresult: null,
      onerror: null,
      onend: null
    }
    instances.push(instance)
    return instance
  })
  ctor.instances = instances
  return ctor
}

describe('createSpeechRecognition', () => {
  it('does not start a recognizer until start() is called', () => {
    const RecognizerCtor = createFakeRecognizerCtor()
    createSpeechRecognition({ getRecognizerCtor: () => RecognizerCtor, onResult: vi.fn() })

    expect(RecognizerCtor).not.toHaveBeenCalled()
  })

  it('start() constructs and starts a recognizer instance', () => {
    const RecognizerCtor = createFakeRecognizerCtor()
    const recognition = createSpeechRecognition({ getRecognizerCtor: () => RecognizerCtor, onResult: vi.fn() })

    recognition.start()

    expect(RecognizerCtor).toHaveBeenCalledOnce()
    expect(RecognizerCtor.instances[0].start).toHaveBeenCalledOnce()
  })

  it('stop() stops the running recognizer instance', () => {
    const RecognizerCtor = createFakeRecognizerCtor()
    const recognition = createSpeechRecognition({ getRecognizerCtor: () => RecognizerCtor, onResult: vi.fn() })

    recognition.start()
    recognition.stop()

    expect(RecognizerCtor.instances[0].stop).toHaveBeenCalledOnce()
  })

  it('stop() before start() is a no-op that does not throw', () => {
    const RecognizerCtor = createFakeRecognizerCtor()
    const recognition = createSpeechRecognition({ getRecognizerCtor: () => RecognizerCtor, onResult: vi.fn() })

    expect(() => recognition.stop()).not.toThrow()
    expect(RecognizerCtor).not.toHaveBeenCalled()
  })

  it('restarts automatically if the recognizer ends itself while still wanted', () => {
    const RecognizerCtor = createFakeRecognizerCtor()
    const recognition = createSpeechRecognition({ getRecognizerCtor: () => RecognizerCtor, onResult: vi.fn() })

    recognition.start()
    // Real Chrome quirk: the underlying API can stop itself mid-session
    // (e.g. after a stretch of silence) without stop() ever being called.
    RecognizerCtor.instances[0].onend()

    expect(RecognizerCtor).toHaveBeenCalledTimes(2)
    expect(RecognizerCtor.instances[1].start).toHaveBeenCalledOnce()
  })

  it('never restarts once told to stop, even if onend fires afterward', () => {
    const RecognizerCtor = createFakeRecognizerCtor()
    const recognition = createSpeechRecognition({ getRecognizerCtor: () => RecognizerCtor, onResult: vi.fn() })

    recognition.start()
    recognition.stop()
    // The browser's own stop() is asynchronous — onend still fires after
    // ours was called. That must not be mistaken for the mid-session
    // Chrome quirk and trigger a restart.
    RecognizerCtor.instances[0].onend()

    expect(RecognizerCtor).toHaveBeenCalledOnce()
  })

  it('reports unsupported and never throws when no recognizer constructor is available', () => {
    const recognition = createSpeechRecognition({ getRecognizerCtor: () => undefined, onResult: vi.fn() })

    expect(recognition.supported).toBe(false)
    expect(() => recognition.start()).not.toThrow()
    expect(() => recognition.stop()).not.toThrow()
  })

  it('forwards each result to onResult with its finality', () => {
    const RecognizerCtor = createFakeRecognizerCtor()
    const onResult = vi.fn()
    const recognition = createSpeechRecognition({ getRecognizerCtor: () => RecognizerCtor, onResult })

    recognition.start()
    const instance = RecognizerCtor.instances[0]
    instance.onresult({
      resultIndex: 0,
      results: [
        Object.assign([{ transcript: 'hello wor' }], { isFinal: false }),
        Object.assign([{ transcript: 'hello world.' }], { isFinal: true })
      ]
    })

    expect(onResult).toHaveBeenNthCalledWith(1, 'hello wor', false)
    expect(onResult).toHaveBeenNthCalledWith(2, 'hello world.', true)
  })

  it('never throws into the caller if the underlying recognizer.start() itself throws', () => {
    const RecognizerCtor = vi.fn(function FakeRecognizer() {
      return { start: vi.fn(() => { throw new Error('mic busy') }), stop: vi.fn(), onresult: null, onend: null }
    })
    const recognition = createSpeechRecognition({ getRecognizerCtor: () => RecognizerCtor, onResult: vi.fn() })

    expect(() => recognition.start()).not.toThrow()
  })

  it('a fired onerror event never throws, even with no error callback wired up', () => {
    const RecognizerCtor = createFakeRecognizerCtor()
    const recognition = createSpeechRecognition({ getRecognizerCtor: () => RecognizerCtor, onResult: vi.fn() })

    recognition.start()
    expect(() => RecognizerCtor.instances[0].onerror({ error: 'network' })).not.toThrow()
  })

  it('defaults to looking for window.SpeechRecognition/webkitSpeechRecognition when no constructor is injected', () => {
    // No `window` at all in this (node) test environment — the real-world
    // "Firefox/Safari, or a Blink browser missing it" case ADR-0001/the
    // Design requirements call out.
    const recognition = createSpeechRecognition({ onResult: vi.fn() })

    expect(recognition.supported).toBe(false)
  })
})
