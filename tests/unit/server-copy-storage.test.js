import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { existsSync, readFileSync, mkdirSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import {
  getServerCopyRoomDir,
  removeServerCopiesForRoom,
  getServerCopyFilePath,
  getServerCopyBytesWritten,
  appendServerCopyChunk,
  getServerCopyWavPath,
  isServerCopyFinalized,
  finalizeServerCopy
} from '../../src/lib/server/server-copy-storage.js'
import { buildWavHeader } from '../../src/lib/recording/audio-utils.js'

let root

beforeEach(() => {
  root = join(tmpdir(), `podcast-recorder-test-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`)
  process.env.SERVER_COPY_DIR = root
})

afterEach(() => {
  if (root) rmSync(root, { recursive: true, force: true })
})

describe('getServerCopyRoomDir', () => {
  it('resolves to a child of the configured root', () => {
    const dir = getServerCopyRoomDir('room1')
    expect(dir).toBe(join(root, 'room1'))
  })

  it('rejects a slug that would escape the root', () => {
    expect(() => getServerCopyRoomDir('../evil')).toThrow()
  })
})

describe('removeServerCopiesForRoom', () => {
  it('deletes the room directory and everything under it', () => {
    const dir = getServerCopyRoomDir('room1')
    mkdirSync(dir, { recursive: true })
    appendServerCopyChunk('room1', 'client1', Buffer.from([1, 2, 3]), 0)
    expect(existsSync(dir)).toBe(true)

    removeServerCopiesForRoom('room1')

    expect(existsSync(dir)).toBe(false)
  })

  it('is a no-op when the room directory never existed', () => {
    expect(() => removeServerCopiesForRoom('never-existed')).not.toThrow()
  })
})

describe('getServerCopyFilePath', () => {
  it('resolves to <roomDir>/<clientId>.pcm', () => {
    const file = getServerCopyFilePath('room1', 'client1')
    expect(file).toBe(join(root, 'room1', 'client1.pcm'))
  })

  it('rejects a clientId that would escape the room directory', () => {
    expect(() => getServerCopyFilePath('room1', '../../evil')).toThrow()
  })
})

describe('getServerCopyBytesWritten', () => {
  it('returns 0 when no server-copy file exists yet', () => {
    expect(getServerCopyBytesWritten('room1', 'client1')).toBe(0)
  })

  it('returns the file size once bytes have been appended', () => {
    appendServerCopyChunk('room1', 'client1', Buffer.from([1, 2, 3, 4]), 0)
    expect(getServerCopyBytesWritten('room1', 'client1')).toBe(4)
  })
})

describe('appendServerCopyChunk', () => {
  it('creates the room directory on first write and appends the bytes', () => {
    const bytesWritten = appendServerCopyChunk('room1', 'client1', Buffer.from([9, 9]), 0)

    expect(bytesWritten).toBe(2)
    const file = getServerCopyFilePath('room1', 'client1')
    expect(readFileSync(file)).toEqual(Buffer.from([9, 9]))
  })

  it('appends subsequent in-order chunks onto the end of the file', () => {
    appendServerCopyChunk('room1', 'client1', Buffer.from([1, 2]), 0)
    const bytesWritten = appendServerCopyChunk('room1', 'client1', Buffer.from([3, 4, 5]), 2)

    expect(bytesWritten).toBe(5)
    const file = getServerCopyFilePath('room1', 'client1')
    expect(readFileSync(file)).toEqual(Buffer.from([1, 2, 3, 4, 5]))
  })

  it('keeps two participants of the same room in separate files', () => {
    appendServerCopyChunk('room1', 'host', Buffer.from([1]), 0)
    appendServerCopyChunk('room1', 'guest', Buffer.from([2]), 0)

    expect(readFileSync(getServerCopyFilePath('room1', 'host'))).toEqual(Buffer.from([1]))
    expect(readFileSync(getServerCopyFilePath('room1', 'guest'))).toEqual(Buffer.from([2]))
  })

  it('rejects a chunk whose offset does not match what is already on disk, and writes nothing', () => {
    appendServerCopyChunk('room1', 'client1', Buffer.from([1, 2]), 0)

    let error
    try {
      appendServerCopyChunk('room1', 'client1', Buffer.from([9, 9, 9]), 0) // stale/duplicate offset
    } catch (e) {
      error = e
    }

    expect(error).toBeTruthy()
    expect(error.code).toBe('OFFSET_MISMATCH')
    expect(error.currentBytes).toBe(2)
    // the mismatched chunk must never have been appended
    expect(readFileSync(getServerCopyFilePath('room1', 'client1'))).toEqual(Buffer.from([1, 2]))
  })

  it('rejects an offset ahead of what is on disk (a gap) the same way', () => {
    expect(() => appendServerCopyChunk('room1', 'client1', Buffer.from([1]), 10))
      .toThrow(expect.objectContaining({ code: 'OFFSET_MISMATCH', currentBytes: 0 }))
  })
})

describe('getServerCopyWavPath', () => {
  it('resolves to <roomDir>/<clientId>.wav', () => {
    expect(getServerCopyWavPath('room1', 'client1')).toBe(join(root, 'room1', 'client1.wav'))
  })

  it('rejects a clientId that would escape the room directory', () => {
    expect(() => getServerCopyWavPath('room1', '../../evil')).toThrow()
  })
})

describe('isServerCopyFinalized', () => {
  it('is false when no finalized WAV exists yet, even with raw chunks on disk', () => {
    appendServerCopyChunk('room1', 'client1', Buffer.from([1, 2]), 0)
    expect(isServerCopyFinalized('room1', 'client1')).toBe(false)
  })

  it('is true once finalizeServerCopy has produced a WAV file', async () => {
    appendServerCopyChunk('room1', 'client1', Buffer.from([1, 2]), 0)
    await finalizeServerCopy('room1', 'client1', { sampleRate: 48000 })
    expect(isServerCopyFinalized('room1', 'client1')).toBe(true)
  })
})

describe('finalizeServerCopy', () => {
  it('writes a RIFF/WAVE header (matching the local writer format) followed by the raw PCM bytes on disk', async () => {
    const pcm = Buffer.from(new Int16Array([1, -1, 1000, -1000]).buffer)
    appendServerCopyChunk('room1', 'client1', pcm, 0)

    await finalizeServerCopy('room1', 'client1', { sampleRate: 44100 })

    const wavBytes = readFileSync(getServerCopyWavPath('room1', 'client1'))
    const expectedHeader = Buffer.from(buildWavHeader(pcm.length, 44100))
    expect(wavBytes.subarray(0, 44)).toEqual(expectedHeader)
    expect(wavBytes.subarray(44)).toEqual(pcm)
    expect(wavBytes.length).toBe(44 + pcm.length)
  })

  it('defaults to 48000 Hz when no sample rate is given, matching the local writer default', async () => {
    appendServerCopyChunk('room1', 'client1', Buffer.from([1, 2]), 0)
    await finalizeServerCopy('room1', 'client1')

    const wavBytes = readFileSync(getServerCopyWavPath('room1', 'client1'))
    const view = new DataView(wavBytes.buffer, wavBytes.byteOffset, wavBytes.byteLength)
    expect(view.getUint32(24, true)).toBe(48000) // sampleRate field
  })

  it('produces a valid, empty-but-well-formed WAV when no bytes were ever uploaded', async () => {
    await finalizeServerCopy('room1', 'never-uploaded', { sampleRate: 48000 })

    const wavBytes = readFileSync(getServerCopyWavPath('room1', 'never-uploaded'))
    expect(wavBytes.length).toBe(44)
    expect(wavBytes.subarray(0, 4).toString('ascii')).toBe('RIFF')
  })

  it('rejects further chunk appends once finalized, and never modifies the finalized file', async () => {
    appendServerCopyChunk('room1', 'client1', Buffer.from([1, 2]), 0)
    await finalizeServerCopy('room1', 'client1')
    const wavBefore = readFileSync(getServerCopyWavPath('room1', 'client1'))

    let error
    try {
      appendServerCopyChunk('room1', 'client1', Buffer.from([9, 9]), 2)
    } catch (e) {
      error = e
    }

    expect(error).toBeTruthy()
    expect(error.code).toBe('ALREADY_FINALIZED')
    expect(readFileSync(getServerCopyWavPath('room1', 'client1'))).toEqual(wavBefore)
  })
})
