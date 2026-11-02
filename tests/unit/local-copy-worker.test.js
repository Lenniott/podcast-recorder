import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// The real worker against a fake OPFS: a crash keeps every acknowledged
// chunk only if each write is flushed before its reply is posted.

function fakeHandle(log, { shortBy = 0 } = {}) {
  return {
    write(view, { at }) { log.push(['write', at, [...view]]); return view.byteLength - shortBy },
    flush() { log.push(['flush']) },
    close() { log.push(['close']) }
  }
}

function fakeStorage(log, handleOptions) {
  const dirs = []
  const directory = (name) => ({
    async getDirectoryHandle(child, options) { dirs.push([name, child, options]); return directory(child) },
    async getFileHandle(file) {
      if (file === 'missing.wav') throw Object.assign(new Error('missing.wav not found'), { name: 'NotFoundError' })
      return { createSyncAccessHandle: async () => fakeHandle(log, handleOptions) }
    }
  })
  return { dirs, getDirectory: async () => directory('root') }
}

let log, replies, storage

async function loadWorker(handleOptions) {
  log = []
  replies = []
  storage = fakeStorage(log, handleOptions)
  vi.stubGlobal('navigator', { storage: { getDirectory: storage.getDirectory } })
  vi.stubGlobal('self', { postMessage: (reply) => { replies.push(reply); log.push(['reply', reply.id]) } })
  vi.resetModules()
  await import('../../src/lib/recording/local-copy-worker.js')
}

async function send(message) {
  await globalThis.self.onmessage({ data: message })
  return replies.at(-1)
}

const take = { room: 'show', name: 'host-take-1.wav' }

describe('local-copy-worker', () => {
  beforeEach(() => loadWorker())
  afterEach(() => vi.unstubAllGlobals())

  it('opens the take under local-copy/<room>', async () => {
    expect(await send({ id: 1, op: 'open', ...take })).toEqual({ id: 1, ok: true })
    expect(storage.dirs).toEqual([
      ['root', 'local-copy', { create: true }],
      ['local-copy', 'show', { create: true }]
    ])
  })

  it('writes at the given position and flushes before acknowledging', async () => {
    await send({ id: 1, op: 'open', ...take })
    log.length = 0
    const reply = await send({ id: 2, op: 'write', ...take, position: 44, bytes: new Uint8Array([1, 2, 3]).buffer })
    expect(reply).toEqual({ id: 2, ok: true })
    expect(log).toEqual([['write', 44, [1, 2, 3]], ['flush'], ['reply', 2]])
  })

  it('fails an incomplete write instead of acknowledging it', async () => {
    await loadWorker({ shortBy: 1 })
    await send({ id: 1, op: 'open', ...take })
    const reply = await send({ id: 2, op: 'write', ...take, position: 0, bytes: new Uint8Array([1, 2]).buffer })
    expect(reply).toEqual({ id: 2, ok: false, error: { name: 'Error', message: 'Local Copy write was incomplete' } })
    expect(log).not.toContainEqual(['flush'])
  })

  it('close flushes then releases the handle; later writes are refused', async () => {
    await send({ id: 1, op: 'open', ...take })
    log.length = 0
    expect(await send({ id: 2, op: 'close', ...take })).toEqual({ id: 2, ok: true })
    expect(log).toEqual([['flush'], ['close'], ['reply', 2]])
    const late = await send({ id: 3, op: 'write', ...take, position: 0, bytes: new Uint8Array([1]).buffer })
    expect(late).toMatchObject({ id: 3, ok: false, error: { message: 'Local Copy host-take-1.wav is not open' } })
  })

  it('abort releases the handle without a flush', async () => {
    await send({ id: 1, op: 'open', ...take })
    log.length = 0
    expect(await send({ id: 2, op: 'abort', ...take })).toEqual({ id: 2, ok: true })
    expect(log).toEqual([['close'], ['reply', 2]])
  })

  it('keeps takes in different rooms apart', async () => {
    await send({ id: 1, op: 'open', ...take })
    const other = await send({ id: 2, op: 'close', room: 'other', name: take.name })
    expect(other).toMatchObject({ ok: false, error: { message: 'Local Copy host-take-1.wav is not open' } })
  })

  it('reports an open failure and an unknown operation with their error names', async () => {
    expect(await send({ id: 1, op: 'open', room: 'show', name: 'missing.wav' }))
      .toEqual({ id: 1, ok: false, error: { name: 'NotFoundError', message: 'missing.wav not found' } })
    await send({ id: 2, op: 'open', ...take })
    expect(await send({ id: 3, op: 'truncate', ...take }))
      .toEqual({ id: 3, ok: false, error: { name: 'Error', message: 'Unknown Local Copy operation: truncate' } })
  })
})
