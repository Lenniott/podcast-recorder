import { describe, it, expect, vi, afterEach } from 'vitest'
import { createSpeechRecognition } from '../../src/lib/speech-recognition.js'

/**
 * A fake SpeechRecognition constructor mirroring audio-engine.test.js's
 * dependency-injection style for a browser API: each `new fakeCtor()` call
 * returns a fresh instance so tests can inspect exactly what was started/
 * stopped, and drive its onstart/onresult/onend/onerror handlers directly
 * instead of touching a real browser API. Includes onstart — a real
 * browser only ever reports "this session actually got going" through it,
 * so a test that means to simulate a session that ran fine before ending
 * must fire it, same as a real browser would before ever firing onend.
 */
function createFakeRecognizerCtor() {
  const instances = []
  const ctor = vi.fn(function FakeRecognizer() {
    const instance = {
      start: vi.fn(),
      stop: vi.fn(),
      abort: vi.fn(),
      onstart: null,
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

/** A fake injected clock — no real setTimeout delays in retry/backoff tests. */
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

afterEach(() => {
  vi.restoreAllMocks()
})

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

  it('restarts immediately, no backoff, when a session that actually ran ends itself', () => {
    const RecognizerCtor = createFakeRecognizerCtor()
    const recognition = createSpeechRecognition({ getRecognizerCtor: () => RecognizerCtor, onResult: vi.fn() })

    recognition.start()
    // Real Chrome quirk: the underlying API can stop itself mid-session
    // (e.g. after a stretch of silence) without stop() ever being called —
    // but only after it actually got going (onstart fired first).
    RecognizerCtor.instances[0].onstart()
    RecognizerCtor.instances[0].onend()

    expect(RecognizerCtor).toHaveBeenCalledTimes(2)
    expect(RecognizerCtor.instances[1].start).toHaveBeenCalledOnce()
  })

  it('never restarts once told to stop, even if onend fires afterward', () => {
    const RecognizerCtor = createFakeRecognizerCtor()
    const recognition = createSpeechRecognition({ getRecognizerCtor: () => RecognizerCtor, onResult: vi.fn() })

    recognition.start()
    RecognizerCtor.instances[0].onstart()
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

  // ─── The actual bug: a session that never got going must still recover ──

  describe('recovery when a session never actually starts', () => {
    it('never throws into the caller if the underlying recognizer.start() itself throws', () => {
      const RecognizerCtor = vi.fn(function FakeRecognizer() {
        return { start: vi.fn(() => { throw new Error('mic busy') }), stop: vi.fn(), onstart: null, onresult: null, onend: null }
      })
      const recognition = createSpeechRecognition({ getRecognizerCtor: () => RecognizerCtor, onResult: vi.fn() })

      expect(() => recognition.start()).not.toThrow()
    })

    it('schedules a backed-off retry — not silent death — when start() throws synchronously', () => {
      const clock = fakeClock()
      let throwCount = 0
      const RecognizerCtor = vi.fn(function FakeRecognizer() {
        return {
          start: vi.fn(() => { throwCount += 1; throw new Error('mic busy') }),
          stop: vi.fn(),
          onstart: null,
          onresult: null,
          onend: null
        }
      })
      const recognition = createSpeechRecognition({
        getRecognizerCtor: () => RecognizerCtor,
        onResult: vi.fn(),
        ...clock
      })

      recognition.start()
      expect(throwCount).toBe(1)
      expect(clock.pendingCount()).toBe(1) // a retry was actually scheduled, not dropped

      clock.fireAll()
      expect(throwCount).toBe(2) // it actually retried
      expect(clock.pendingCount()).toBe(1) // and scheduled the next one too — never gives up
    })

    it('a stop() call cancels a pending retry so a failed mic never restarts after being told to stop', () => {
      const clock = fakeClock()
      const RecognizerCtor = vi.fn(function FakeRecognizer() {
        return { start: vi.fn(() => { throw new Error('mic busy') }), stop: vi.fn(), onstart: null, onresult: null, onend: null }
      })
      const recognition = createSpeechRecognition({ getRecognizerCtor: () => RecognizerCtor, onResult: vi.fn(), ...clock })

      recognition.start()
      expect(clock.pendingCount()).toBe(1)
      recognition.stop()

      expect(clock.clearTimeoutFn).toHaveBeenCalled()
      clock.fireAll() // even if something slipped through, firing it must not restart
      expect(RecognizerCtor).toHaveBeenCalledOnce()
    })

    it('an onend with no preceding onstart is treated as a failed attempt, not the benign restart-immediately case', () => {
      const clock = fakeClock()
      const RecognizerCtor = createFakeRecognizerCtor()
      const recognition = createSpeechRecognition({ getRecognizerCtor: () => RecognizerCtor, onResult: vi.fn(), ...clock })

      recognition.start()
      // onend fires WITHOUT onstart ever having fired first — e.g. the
      // browser gave up before really starting.
      RecognizerCtor.instances[0].onend()

      // Not restarted synchronously (that's only for the confirmed-running
      // case) — a backed-off retry was scheduled instead.
      expect(RecognizerCtor).toHaveBeenCalledOnce()
      expect(clock.pendingCount()).toBe(1)

      clock.fireAll()
      expect(RecognizerCtor).toHaveBeenCalledTimes(2)
    })

    it('a confirmed start resets the backoff, so a later failure starts counting from scratch', () => {
      const clock = fakeClock()
      const RecognizerCtor = createFakeRecognizerCtor()
      const recognition = createSpeechRecognition({ getRecognizerCtor: () => RecognizerCtor, onResult: vi.fn(), ...clock })

      recognition.start()
      RecognizerCtor.instances[0].onstart()
      RecognizerCtor.instances[0].onend() // benign — restarts immediately, no retry scheduled
      expect(clock.pendingCount()).toBe(0)
      expect(RecognizerCtor).toHaveBeenCalledTimes(2)

      // This new instance never gets going — should schedule attempt #1's
      // delay again, not continue from some earlier attempt count.
      RecognizerCtor.instances[1].onend()
      expect(clock.setTimeoutFn).toHaveBeenLastCalledWith(expect.any(Function), expect.any(Number))
      const firstDelay = clock.setTimeoutFn.mock.calls.at(-1)[1]
      expect(firstDelay).toBeGreaterThanOrEqual(500) // ~1s base * 0.5 jitter floor
      expect(firstDelay).toBeLessThanOrEqual(1000)
    })
  })

  describe('status reporting', () => {
    it('reports unsupported immediately when no recognizer constructor is available', () => {
      const onStatusChange = vi.fn()
      const recognition = createSpeechRecognition({ getRecognizerCtor: () => undefined, onResult: vi.fn(), onStatusChange })

      expect(recognition.status).toBe('unsupported')
      expect(onStatusChange).not.toHaveBeenCalled() // nothing changed after construction — no event needed
    })

    it('reports starting, then running, once the recognizer actually starts', () => {
      const onStatusChange = vi.fn()
      const RecognizerCtor = createFakeRecognizerCtor()
      const recognition = createSpeechRecognition({ getRecognizerCtor: () => RecognizerCtor, onResult: vi.fn(), onStatusChange })

      recognition.start()
      expect(recognition.status).toBe('starting')
      RecognizerCtor.instances[0].onstart()
      expect(recognition.status).toBe('running')

      expect(onStatusChange.mock.calls.map((c) => c[0])).toEqual(['starting', 'running'])
    })

    it('reports retrying while a failed start is backing off, then stopped after stop()', () => {
      const onStatusChange = vi.fn()
      const clock = fakeClock()
      const RecognizerCtor = vi.fn(function FakeRecognizer() {
        return { start: vi.fn(() => { throw new Error('mic busy') }), stop: vi.fn(), onstart: null, onresult: null, onend: null }
      })
      const recognition = createSpeechRecognition({ getRecognizerCtor: () => RecognizerCtor, onResult: vi.fn(), onStatusChange, ...clock })

      recognition.start()
      expect(recognition.status).toBe('retrying')
      recognition.stop()
      expect(recognition.status).toBe('stopped')

      expect(onStatusChange.mock.calls.map((c) => c[0])).toEqual(['starting', 'retrying', 'stopped'])
    })
  })
})
