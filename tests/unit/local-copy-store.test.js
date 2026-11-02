import { describe, expect, it } from 'vitest'
import { buildWavHeader } from '../../src/lib/recording/audio-utils.js'
import {
  attemptFileName,
  createLocalCopyStore,
  createWorkerFiles,
  describeLocalCopy,
  localCopyRemoveMessage,
  localCopySupported,
  localCopyWav,
  requestLocalCopyPersistence,
  takeNumber
} from '../../src/lib/recording/local-copy-store.js'

const HOST_SHOW = {
  participantName: 'Host',
  roomName: 'Show',
  now: new Date('2026-09-30T12:00:00.000Z')
}

function wavBytes({ headerDataBytes, audioBytes, sampleRate = 48000 }) {
  const audio = new Uint8Array(audioBytes).map((_, i) => i % 251)
  const out = new Uint8Array(44 + audioBytes)
  out.set(new Uint8Array(buildWavHeader(headerDataBytes, sampleRate)), 0)
  out.set(audio, 44)
  return out
}

function fakeFolder() {
  const files = new Map()
  const requested = []
  const removed = []
  const folder = {
    files,
    requested,
    removed,
    async getFileHandle(name, options) {
      requested.push({ name, options })
      if (!files.has(name)) {
        if (!options?.create) throw Object.assign(new Error(`${name} not found`), { name: 'NotFoundError' })
        files.set(name, new Uint8Array(0))
      }
      return { kind: 'file', name }
    },
    async *entries() {
      for (const [name, bytes] of files) {
        yield [name, { kind: 'file', name, getFile: async () => new File([bytes], name, { lastModified: 1 }) }]
      }
    },
    async removeEntry(name) {
      removed.push(name)
      files.delete(name)
    }
  }
  const base = { getDirectoryHandle: async (name) => { folder.roomName = name; return folder } }
  const root = { getDirectoryHandle: async (name) => { expect(name).toBe('local-copy'); return base } }
  return { folder, getRoot: async () => root }
}

function fakeWorkerFiles() {
  const opened = []
  return {
    opened,
    async open({ room, name }) {
      opened.push({ room, name })
      return { name }
    }
  }
}

describe('attemptFileName', () => {
  it('names an attempt by participant, episode, day, and take number', () => {
    expect(attemptFileName({ ...HOST_SHOW, attempt: 3 })).toBe('host-show-2026-09-30-take-3.wav')
  })

  it('falls back to guest and episode when names are missing', () => {
    expect(attemptFileName({ participantName: '', roomName: '', now: new Date('2026-01-02T00:00:00.000Z'), attempt: 1 }))
      .toBe('guest-episode-2026-01-02-take-1.wav')
  })

  it('reads the take number back out of a stored name', () => {
    expect(takeNumber('host-show-2026-09-30-take-12.wav')).toBe(12)
    expect(takeNumber('notes.txt')).toBeNull()
  })
})

describe('localCopyRemoveMessage', () => {
  const take = { name: 'host-show-2026-09-30-take-2.wav' }

  it('after Save, asks them to check the saved file opens before removing', () => {
    const message = localCopyRemoveMessage(take, true)
    expect(message).toContain('Take 2')
    expect(message).toContain('once the saved file opens')
  })

  it('without Save, says plainly the recording will be deleted', () => {
    const message = localCopyRemoveMessage(take, false)
    expect(message).toContain("Take 2 hasn't been saved")
    expect(message).toContain('deletes this recording')
  })
})

describe('describeLocalCopy', () => {
  it('reads a cleanly closed take: header length matches the audio on disk', () => {
    const bytes = wavBytes({ headerDataBytes: 96000, audioBytes: 96000 })
    const take = describeLocalCopy({ name: 'a.wav', size: bytes.byteLength, header: bytes.slice(0, 44).buffer })
    expect(take).toEqual({ name: 'a.wav', sampleRate: 48000, dataBytes: 96000, durationSeconds: 1, endedEarly: false })
  })

  it('marks a take whose header was never patched as ended early, with the length on disk', () => {
    const bytes = wavBytes({ headerDataBytes: 0, audioBytes: 48000 })
    const take = describeLocalCopy({ name: 'a.wav', size: bytes.byteLength, header: bytes.slice(0, 44).buffer })
    expect(take.endedEarly).toBe(true)
    expect(take.dataBytes).toBe(48000)
    expect(take.durationSeconds).toBe(0.5)
  })

  it('drops a half-written last sample instead of handing out a misaligned WAV', () => {
    const bytes = wavBytes({ headerDataBytes: 0, audioBytes: 1001 })
    const take = describeLocalCopy({ name: 'a.wav', size: bytes.byteLength, header: bytes.slice(0, 44).buffer })
    expect(take.dataBytes).toBe(1000)
  })

  it('ignores a take with no audio and anything that is not one of our WAVs', () => {
    const empty = wavBytes({ headerDataBytes: 0, audioBytes: 0 })
    expect(describeLocalCopy({ name: 'a.wav', size: 44, header: empty.buffer })).toBeNull()
    const junk = new Uint8Array(100)
    expect(describeLocalCopy({ name: 'b.wav', size: 100, header: junk.slice(0, 44).buffer })).toBeNull()
  })
})

describe('localCopyWav', () => {
  it('builds the saved WAV from a repaired header and the stored audio, leaving the stored file alone', async () => {
    const bytes = wavBytes({ headerDataBytes: 0, audioBytes: 1001 })
    const file = new File([bytes], 'a.wav')
    const take = describeLocalCopy({ name: 'a.wav', size: bytes.byteLength, header: bytes.slice(0, 44).buffer })

    const wav = new Uint8Array(await localCopyWav(take, file).arrayBuffer())

    expect(wav.byteLength).toBe(44 + 1000)
    expect(new DataView(wav.buffer).getUint32(40, true)).toBe(1000)
    expect(new DataView(wav.buffer).getUint32(4, true)).toBe(36 + 1000)
    expect(wav.slice(44)).toEqual(bytes.slice(44, 44 + 1000))
    expect(new DataView(bytes.buffer).getUint32(40, true)).toBe(0)
  })
})

describe('createLocalCopyStore', () => {
  it('opens take-1 in this room\'s own folder and hands it to the worker', async () => {
    const { folder, getRoot } = fakeFolder()
    const workerFiles = fakeWorkerFiles()
    const store = createLocalCopyStore({ slug: 'ep/42', getRoot, workerFiles })

    const first = await store.openNext(HOST_SHOW)

    expect(folder.roomName).toBe('ep-42')
    expect(first).toEqual({ attempt: 1, name: 'host-show-2026-09-30-take-1.wav', file: { name: 'host-show-2026-09-30-take-1.wav' } })
    expect(workerFiles.opened).toEqual([{ room: 'ep-42', name: 'host-show-2026-09-30-take-1.wav' }])
  })

  it('opens take-2 next and never asks to create take-1 again', async () => {
    const { folder, getRoot } = fakeFolder()
    const store = createLocalCopyStore({ slug: 'ep', getRoot, workerFiles: fakeWorkerFiles() })
    await store.openNext(HOST_SHOW)
    const afterFirst = folder.requested.length

    const second = await store.openNext(HOST_SHOW)

    expect(second.name).toBe('host-show-2026-09-30-take-2.wav')
    expect(folder.requested.slice(afterFirst).map((r) => r.name)).not.toContain('host-show-2026-09-30-take-1.wav')
  })

  it('skips a take left by an earlier visit instead of writing over it', async () => {
    const { folder, getRoot } = fakeFolder()
    const earlier = wavBytes({ headerDataBytes: 0, audioBytes: 10 })
    folder.files.set('host-show-2026-09-30-take-1.wav', earlier)
    const store = createLocalCopyStore({ slug: 'ep', getRoot, workerFiles: fakeWorkerFiles() })

    const next = await store.openNext(HOST_SHOW)

    expect(next).toMatchObject({ attempt: 2, name: 'host-show-2026-09-30-take-2.wav' })
    expect(folder.files.get('host-show-2026-09-30-take-1.wav')).toBe(earlier)
    expect(folder.requested).not.toContainEqual({ name: 'host-show-2026-09-30-take-1.wav', options: { create: true } })
  })

  it('surfaces a folder it can no longer read instead of opening a file blind', async () => {
    const { folder, getRoot } = fakeFolder()
    folder.getFileHandle = async () => { throw Object.assign(new Error('Permission revoked'), { name: 'NotAllowedError' }) }
    const workerFiles = fakeWorkerFiles()
    const store = createLocalCopyStore({ slug: 'ep', getRoot, workerFiles })

    await expect(store.openNext(HOST_SHOW)).rejects.toThrow('Permission revoked')
    expect(workerFiles.opened).toEqual([])
  })

  it('lists takes with audio in take order, leaving out the one still being written and empty ones', async () => {
    const { folder, getRoot } = fakeFolder()
    folder.files.set('h-take-10.wav', wavBytes({ headerDataBytes: 96000, audioBytes: 96000 }))
    folder.files.set('h-take-2.wav', wavBytes({ headerDataBytes: 0, audioBytes: 48000 }))
    folder.files.set('h-take-3.wav', wavBytes({ headerDataBytes: 0, audioBytes: 0 }))
    folder.files.set('h-take-11.wav', wavBytes({ headerDataBytes: 0, audioBytes: 480 }))
    const store = createLocalCopyStore({ slug: 'ep', getRoot, workerFiles: fakeWorkerFiles() })

    const takes = await store.list({ exclude: ['h-take-11.wav'] })

    expect(takes.map(({ name, durationSeconds, endedEarly }) => ({ name, durationSeconds, endedEarly }))).toEqual([
      { name: 'h-take-2.wav', durationSeconds: 0.5, endedEarly: true },
      { name: 'h-take-10.wav', durationSeconds: 1, endedEarly: false }
    ])
    expect(takes[0].file).toBeInstanceOf(Blob)
  })

  it('reports a take it cannot read rather than failing the whole list', async () => {
    const { folder, getRoot } = fakeFolder()
    folder.files.set('h-take-1.wav', wavBytes({ headerDataBytes: 96000, audioBytes: 96000 }))
    const entries = folder.entries.bind(folder)
    folder.entries = async function* () {
      yield ['locked.wav', { kind: 'file', getFile: async () => { throw new Error('in use') } }]
      yield* entries()
    }
    const unreadable = []
    const store = createLocalCopyStore({ slug: 'ep', getRoot, workerFiles: fakeWorkerFiles() })

    const takes = await store.list({ onUnreadable: (info) => unreadable.push(info.name) })

    expect(takes.map((t) => t.name)).toEqual(['h-take-1.wav'])
    expect(unreadable).toEqual(['locked.wav'])
  })

  it('removes only the take it is asked to remove', async () => {
    const { folder, getRoot } = fakeFolder()
    folder.files.set('a.wav', new Uint8Array(1))
    folder.files.set('b.wav', new Uint8Array(1))
    const store = createLocalCopyStore({ slug: 'ep', getRoot, workerFiles: fakeWorkerFiles() })

    await store.remove('a.wav')

    expect(folder.removed).toEqual(['a.wav'])
    expect([...folder.files.keys()]).toEqual(['b.wav'])
  })
})

function fakeWorker({ fail } = {}) {
  const messages = []
  const worker = {
    messages,
    postMessage(message, transfer) {
      messages.push({ message, transfer })
      queueMicrotask(() => {
        const error = fail?.(message)
        worker.onmessage({ data: error ? { id: message.id, ok: false, error } : { id: message.id, ok: true } })
      })
    }
  }
  return worker
}

describe('createWorkerFiles', () => {
  it('writes each chunk at the running position and the header back at the start', async () => {
    const worker = fakeWorker()
    const files = createWorkerFiles({ createWorker: () => worker })
    const file = await files.open({ room: 'ep', name: 'a.wav' })

    await file.write(new ArrayBuffer(44))
    await file.write(new Int16Array(10).buffer)
    await file.seek(0)
    await file.write(new ArrayBuffer(44))
    await file.close()

    expect(worker.messages.map(({ message }) => [message.op, message.position])).toEqual([
      ['open', undefined], ['write', 0], ['write', 44], ['write', 0], ['close', undefined]
    ])
  })

  it('copies samples to the worker so the waveform can still read them after the write', async () => {
    const worker = fakeWorker()
    const files = createWorkerFiles({ createWorker: () => worker })
    const file = await files.open({ room: 'ep', name: 'a.wav' })
    const samples = new Int16Array([1, 2, 3])

    await file.write(samples.buffer)

    expect(worker.messages.at(-1).transfer).toBeUndefined()
    expect(samples.byteLength).toBe(6)
    expect(Array.from(samples)).toEqual([1, 2, 3])
  })

  it('rejects a write the worker could not land, and keeps the position where it was', async () => {
    let failNext = false
    const worker = fakeWorker({ fail: (m) => (m.op === 'write' && failNext ? { name: 'QuotaExceededError', message: 'full' } : null) })
    const files = createWorkerFiles({ createWorker: () => worker })
    const file = await files.open({ room: 'ep', name: 'a.wav' })
    await file.write(new ArrayBuffer(44))
    failNext = true

    await expect(file.write(new ArrayBuffer(8))).rejects.toMatchObject({ name: 'QuotaExceededError', message: 'full' })
    failNext = false
    await file.write(new ArrayBuffer(8))
    expect(worker.messages.at(-1).message.position).toBe(44)
  })

  it('fails every pending and later request once the worker itself breaks', async () => {
    const worker = { postMessage() {} }
    const files = createWorkerFiles({ createWorker: () => worker })
    const opening = files.open({ room: 'ep', name: 'a.wav' })

    worker.onerror({ message: 'script failed', preventDefault() {} })

    await expect(opening).rejects.toThrow('script failed')
    await expect(files.open({ room: 'ep', name: 'b.wav' })).rejects.toThrow('script failed')
  })
})

describe('browser support', () => {
  it('needs private file storage and workers', () => {
    expect(localCopySupported({ navigator: { storage: { getDirectory() {} } }, Worker: function () {} })).toBe(true)
    expect(localCopySupported({ navigator: { storage: {} }, Worker: function () {} })).toBe(false)
    expect(localCopySupported({ navigator: { storage: { getDirectory() {} } } })).toBe(false)
  })

  it('asks the browser to keep storage, and a refusal or missing API still resolves', async () => {
    expect(await requestLocalCopyPersistence({ persist: async () => true })).toBe(true)
    expect(await requestLocalCopyPersistence({ persist: async () => { throw new Error('no') } })).toBe(false)
    expect(await requestLocalCopyPersistence({ persist: () => { throw new Error('sync') } })).toBe(false)
    expect(await requestLocalCopyPersistence(undefined)).toBe(false)
  })
})
