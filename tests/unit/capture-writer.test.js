import { describe, it, expect, vi } from 'vitest'
import { createCaptureWriter } from '../../src/lib/capture-writer.js'

const SAMPLE_RATE = 48000
const BUFFER_SIZE = 8192 // matches static/worklet/recorder-processor.js

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/** A fake slow disk: every write() takes `latencyMs`, regardless of size —
 *  this is the exact condition that produced the production bug. */
function makeSlowSink(latencyMs) {
  const written = []
  return {
    written,
    write: vi.fn(async (buf) => {
      await delay(latencyMs)
      written.push(new Int16Array(buf))
    })
  }
}

function realChunk(n = BUFFER_SIZE, fill = 1) {
  const i16 = new Int16Array(n)
  i16.fill(fill)
  return i16
}

// ─── regression: the diagnosed bug ─────────────────────────────────────────
// A write() that is slower than the real-time duration of one chunk must
// NEVER cause silence to be fabricated — only notifyDeviceGap() may do that.

describe('createCaptureWriter — slow disk does not fabricate silence', () => {
  it('writes only real audio, never silence, when write() is slower than real-time', async () => {
    // 250ms/write vs 170.7ms of real audio per chunk — the exact regime
    // that produced ~0.33s of manufactured silence per ~0.17s of speech.
    const sink = makeSlowSink(250)
    const writer = createCaptureWriter({ sampleRate: SAMPLE_RATE, write: sink.write })

    for (let i = 0; i < 6; i++) {
      writer.writeChunk(realChunk())
      await delay(BUFFER_SIZE / SAMPLE_RATE * 1000) // arrive at the worklet's real-time cadence
    }
    await writer.stop()

    expect(sink.written.length).toBe(6)
    for (const chunk of sink.written) {
      // every written chunk is the real (non-zero) audio we queued —
      // no interleaved all-zero silence chunk anywhere in the file
      expect(chunk.every((s) => s === 1)).toBe(true)
    }
    expect(writer.samplesWritten).toBe(6 * BUFFER_SIZE)
  })

  it('backlog from a slow disk never turns into gapSamples math at all', async () => {
    const sink = makeSlowSink(500) // much slower than one chunk's real-time duration
    const writer = createCaptureWriter({ sampleRate: SAMPLE_RATE, write: sink.write })

    for (let i = 0; i < 4; i++) writer.writeChunk(realChunk())
    await writer.stop()

    // 4 real chunks in, 4 real chunks out — no bonus silence chunks,
    // regardless of how far behind the disk fell.
    expect(sink.written.length).toBe(4)
    expect(writer.dataByteCount).toBe(4 * BUFFER_SIZE * 2)
  })
})

// ─── onWritten: the seam anything showing "what's really on disk" needs ────

describe('createCaptureWriter — onWritten', () => {
  it('fires only after a chunk\'s write() has actually resolved, never on writeChunk() being called', async () => {
    let resolveWrite
    const seen = []
    const writer = createCaptureWriter({
      sampleRate: SAMPLE_RATE,
      write: () => new Promise((resolve) => { resolveWrite = resolve }),
      onWritten: (i16) => seen.push(i16[0])
    })

    writer.writeChunk(realChunk(4, 7))
    await delay(20)
    expect(seen).toEqual([]) // write() hasn't resolved yet — must not have fired

    resolveWrite()
    await delay(20)
    expect(seen).toEqual([7]) // now it has
  })

  it('reports the correct sample offset for each chunk, in write order', async () => {
    const sink = makeSlowSink(0)
    const seen = []
    const writer = createCaptureWriter({
      sampleRate: SAMPLE_RATE,
      write: sink.write,
      onWritten: (i16, offset) => seen.push(offset)
    })

    writer.writeChunk(realChunk(100))
    writer.writeChunk(realChunk(100))
    writer.writeChunk(realChunk(100))
    await writer.stop()

    expect(seen).toEqual([0, 100, 200])
  })

  it('fires for notifyDeviceGap silence too — it reflects everything actually written, not just real audio', async () => {
    const sink = makeSlowSink(0)
    const seen = []
    const writer = createCaptureWriter({
      sampleRate: SAMPLE_RATE,
      write: sink.write,
      onWritten: (i16) => seen.push(i16.length)
    })

    writer.notifyDeviceGap(0.1) // 4800 samples at 48kHz
    await writer.stop()

    expect(seen).toEqual([4800])
  })

  it('is optional — omitting it changes nothing else about behavior', async () => {
    const sink = makeSlowSink(0)
    const writer = createCaptureWriter({ sampleRate: SAMPLE_RATE, write: sink.write })
    writer.writeChunk(realChunk())
    await expect(writer.stop()).resolves.toBeTruthy()
  })
})

// ─── notifyDeviceGap: the only legitimate source of silence ────────────────

describe('createCaptureWriter — notifyDeviceGap', () => {
  it('backfills exactly durationSec of silence, in samples', async () => {
    const sink = makeSlowSink(0)
    const writer = createCaptureWriter({ sampleRate: SAMPLE_RATE, write: sink.write })

    writer.notifyDeviceGap(0.5) // 500ms real device gap
    await writer.stop()

    expect(sink.written.length).toBe(1)
    expect(sink.written[0].length).toBe(Math.round(0.5 * SAMPLE_RATE))
    expect(sink.written[0].every((s) => s === 0)).toBe(true)
  })

  it('ignores non-positive or missing durations', async () => {
    const sink = makeSlowSink(0)
    const writer = createCaptureWriter({ sampleRate: SAMPLE_RATE, write: sink.write })

    writer.notifyDeviceGap(0)
    writer.notifyDeviceGap(-1)
    writer.notifyDeviceGap(undefined)
    await writer.stop()

    expect(sink.written.length).toBe(0)
  })

  it('interleaves real audio and a real gap in the order reported', async () => {
    const sink = makeSlowSink(0)
    const writer = createCaptureWriter({ sampleRate: SAMPLE_RATE, write: sink.write })

    writer.writeChunk(realChunk(100, 1))
    writer.notifyDeviceGap(0.1)
    writer.writeChunk(realChunk(100, 2))
    await writer.stop()

    expect(sink.written.map((c) => c.length)).toEqual([100, Math.round(0.1 * SAMPLE_RATE), 100])
    expect(sink.written[0].every((s) => s === 1)).toBe(true)
    expect(sink.written[1].every((s) => s === 0)).toBe(true)
    expect(sink.written[2].every((s) => s === 2)).toBe(true)
  })
})

// ─── regression: the OLD handler's reentrancy bug ──────────────────────────
// The old inline handler only incremented its sample counter AFTER an
// `await fileWritable.write(...)` resolved. Because the browser doesn't wait
// for one message handler to finish before delivering the next, an
// overlapping handler could read that counter while it was still stale —
// inflating its own gap estimate and, worse, queuing its real chunk's write
// call LATER than chunks that arrived after it. Real audio ended up written
// out of chronological order, diluted with escalating fabricated silence —
// which is why deleting the silence from an affected recording never
// reconstructed coherent speech. writeChunk() must never be able to do this:
// no await in the caller's path, no shared counter read before it's safe to.

describe('createCaptureWriter — immune to the old handler-reentrancy bug', () => {
  it('writes real chunks in exact call order under jittery latency worse than the chunk cadence', async () => {
    const N = 40
    const CHUNK_MS = (BUFFER_SIZE / SAMPLE_RATE) * 1000 // ~170.7ms real-time cadence
    const callOrder = []
    const writer = createCaptureWriter({
      sampleRate: SAMPLE_RATE,
      write: async (buf) => {
        const id = new Int16Array(buf)[0]
        await delay(150 + Math.random() * 200) // 150-350ms — worse than the 170.7ms cadence
        callOrder.push(id)
      }
    })

    for (let i = 1; i <= N; i++) {
      const chunk = realChunk(BUFFER_SIZE, 1)
      chunk[0] = i // tag each chunk so we can verify write() saw it in order
      writer.writeChunk(chunk)
      await delay(CHUNK_MS) // arrive at the worklet's real-time cadence, not waiting on writes
    }
    await writer.stop()

    expect(callOrder).toEqual(Array.from({ length: N }, (_, i) => i + 1))
  }, 25000)
})

// ─── stop()/drain(): no more "sleep and hope" ───────────────────────────────

describe('createCaptureWriter — stop() drains the real queue instead of guessing', () => {
  it('stop() waits for every queued write to actually complete before resolving', async () => {
    const sink = makeSlowSink(200)
    const writer = createCaptureWriter({ sampleRate: SAMPLE_RATE, write: sink.write })

    writer.writeChunk(realChunk())
    writer.writeChunk(realChunk())
    writer.writeChunk(realChunk())

    const result = await writer.stop()

    // Unlike the old fixed 300ms setTimeout, this holds regardless of how
    // many chunks were backlogged — 3 * 200ms > 300ms, and it still waited.
    expect(sink.written.length).toBe(3)
    expect(result.samplesWritten).toBe(3 * BUFFER_SIZE)
    expect(result.dataByteCount).toBe(3 * BUFFER_SIZE * 2)
  })

  it('rejects further writes once stopped', async () => {
    const sink = makeSlowSink(0)
    const writer = createCaptureWriter({ sampleRate: SAMPLE_RATE, write: sink.write })
    await writer.stop()

    writer.writeChunk(realChunk())
    writer.notifyDeviceGap(1)
    await writer.drain()

    expect(sink.written.length).toBe(0)
  })

  it('drain() catches up even when new writes are queued while awaiting it', async () => {
    const sink = makeSlowSink(50)
    const writer = createCaptureWriter({ sampleRate: SAMPLE_RATE, write: sink.write })

    writer.writeChunk(realChunk())
    const drainPromise = writer.drain()
    writer.writeChunk(realChunk()) // queued after drain() was already called
    await drainPromise

    expect(sink.written.length).toBe(2)
  })
})

// ─── future upload mirror seam ─────────────────────────────────────────────
// This ticket adds no upload feature. It locks in that a future "server
// copy" mirror can attach to onWritten — the confirmed-write seam — without
// ever being able to delay, corrupt, or block the local WAV write path.
// A mirror in these tests stands in for that future code: it's just a
// function passed as `onWritten` that a later ticket would use to push
// confirmed chunks to a network queue.

describe('createCaptureWriter — future upload mirror cannot delay local writes', () => {
  it('a slow mirror does not delay subsequent local chunk writes', async () => {
    const sink = makeSlowSink(0) // local disk is instant
    const mirrorSeen = []
    let releaseMirror
    const mirror = vi.fn((i16, offset) => {
      mirrorSeen.push(offset)
      // The FIRST call hangs forever (simulates a stalled upload). If the
      // writer ever awaited this, every later chunk would never write.
      if (mirrorSeen.length === 1) {
        return new Promise((resolve) => { releaseMirror = resolve })
      }
    })
    const writer = createCaptureWriter({ sampleRate: SAMPLE_RATE, write: sink.write, onWritten: mirror })

    writer.writeChunk(realChunk(100))
    writer.writeChunk(realChunk(100))
    writer.writeChunk(realChunk(100))
    await writer.stop() // must resolve without ever waiting on the hung mirror

    expect(sink.written.length).toBe(3)
    expect(writer.samplesWritten).toBe(300)
    // the still-pending first mirror call never got in the way
    expect(releaseMirror).toBeTypeOf('function')
  })

  it('a slow mirror does not delay stop()/finalization timing', async () => {
    const sink = makeSlowSink(0)
    const writer = createCaptureWriter({
      sampleRate: SAMPLE_RATE,
      write: sink.write,
      onWritten: () => delay(5000) // wildly slower than any local write
    })

    writer.writeChunk(realChunk())
    const start = Date.now()
    const result = await writer.stop()
    const elapsed = Date.now() - start

    expect(elapsed).toBeLessThan(500) // nowhere near the mirror's 5s
    expect(result.samplesWritten).toBe(BUFFER_SIZE)
  })
})

describe('createCaptureWriter — future upload mirror cannot corrupt or block local writes', () => {
  it('a mirror that throws synchronously does not stop later chunks from being written', async () => {
    const sink = makeSlowSink(0)
    const writer = createCaptureWriter({
      sampleRate: SAMPLE_RATE,
      write: sink.write,
      onWritten: (i16, offset) => {
        if (offset === 0) throw new Error('mirror blew up')
      }
    })

    writer.writeChunk(realChunk(100, 1))
    writer.writeChunk(realChunk(100, 2))
    writer.writeChunk(realChunk(100, 3))
    const result = await writer.stop()

    // all three real chunks made it to disk in order, despite the first
    // mirror invocation throwing
    expect(sink.written.length).toBe(3)
    expect(sink.written.map((c) => c[0])).toEqual([1, 2, 3])
    expect(result.samplesWritten).toBe(300)
  })

  it('a mirror whose returned promise rejects does not stop later chunks from being written', async () => {
    const sink = makeSlowSink(0)
    const writer = createCaptureWriter({
      sampleRate: SAMPLE_RATE,
      write: sink.write,
      onWritten: async (i16, offset) => {
        if (offset === 0) throw new Error('upload failed')
      }
    })

    writer.writeChunk(realChunk(100, 1))
    writer.writeChunk(realChunk(100, 2))
    const result = await writer.stop()

    expect(sink.written.length).toBe(2)
    expect(result.samplesWritten).toBe(200)
    expect(result.dataByteCount).toBe(400)
  })

  it('a mirror that throws on every call still leaves the full WAV written and finalized', async () => {
    const sink = makeSlowSink(0)
    const writer = createCaptureWriter({
      sampleRate: SAMPLE_RATE,
      write: sink.write,
      onWritten: () => { throw new Error('mirror always fails') }
    })

    for (let i = 0; i < 5; i++) writer.writeChunk(realChunk(100, i + 1))
    const result = await writer.stop()

    expect(sink.written.length).toBe(5)
    expect(result.samplesWritten).toBe(500)
  })

  it('a hung mirror does not prevent drain() from resolving or later writes from queuing', async () => {
    const sink = makeSlowSink(0)
    const writer = createCaptureWriter({
      sampleRate: SAMPLE_RATE,
      write: sink.write,
      onWritten: () => new Promise(() => {}) // never resolves, ever
    })

    writer.writeChunk(realChunk(100, 1))
    await writer.drain()
    writer.writeChunk(realChunk(100, 2)) // queued after a drain() that already returned
    await writer.drain()

    expect(sink.written.length).toBe(2)
  })
})

describe('createCaptureWriter — local write confirmation is never gated on the mirror settling', () => {
  it('samplesWritten/dataByteCount and onWritten itself fire before the mirror has settled, not after', async () => {
    let mirrorSettled = false
    let sawUnsettledMirrorAtNotifyTime = false
    const sink = makeSlowSink(0)
    const writer = createCaptureWriter({
      sampleRate: SAMPLE_RATE,
      write: sink.write,
      onWritten: () => {
        // At the moment the mirror is invoked, local state must already be
        // authoritative — the mirror is downstream, never a gate.
        if (writer.samplesWritten === 100 && !mirrorSettled) {
          sawUnsettledMirrorAtNotifyTime = true
        }
        return delay(50).then(() => { mirrorSettled = true })
      }
    })

    writer.writeChunk(realChunk(100))
    await writer.stop() // resolves long before the mirror's 50ms settles

    expect(sawUnsettledMirrorAtNotifyTime).toBe(true)
    expect(mirrorSettled).toBe(false) // proves stop() did NOT wait for the mirror
    expect(writer.samplesWritten).toBe(100)
  })

  it('fails the intent of the seam if write confirmation were (hypothetically) awaited on the mirror', async () => {
    // This test exists to fail loudly if a future change makes writeChunk's
    // internal handler `await` the mirror instead of firing it and moving
    // on. A mirror that never resolves must never make local writes never
    // finish.
    const sink = makeSlowSink(0)
    const writer = createCaptureWriter({
      sampleRate: SAMPLE_RATE,
      write: sink.write,
      onWritten: () => new Promise(() => {}) // simulates a network call that never completes
    })

    writer.writeChunk(realChunk())

    const result = await Promise.race([
      writer.stop().then(() => 'stopped'),
      delay(1000).then(() => 'timed-out')
    ])

    expect(result).toBe('stopped')
  })
})

describe('createCaptureWriter — pending', () => {
  it('counts queued writes until they flush', async () => {
    const releases = []
    const writer = createCaptureWriter({
      sampleRate: SAMPLE_RATE,
      write: () => new Promise((resolve) => { releases.push(resolve) })
    })

    expect(writer.pending).toBe(0)
    writer.writeChunk(realChunk())
    writer.writeChunk(realChunk())
    expect(writer.pending).toBe(2)

    await delay(0)
    expect(releases).toHaveLength(1)
    releases[0]()
    await delay(0)
    expect(writer.pending).toBe(1)
    expect(releases).toHaveLength(2)

    releases[1]()
    await writer.drain()
    expect(writer.pending).toBe(0)
  })
})
